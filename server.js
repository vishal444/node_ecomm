const express = require("express");
const app = express();
const http = require("http").createServer(app);
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2");
const formidable = require("formidable");

// Define the connection pool
const db_config = {
  host: "localhost",
  user: "root",
  password: "vroot@4",
  database: "ecomm",
  port: 3306,
};

const port = 3000;

http.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

// Create a connection pool
const connection_pool = mysql.createPool(db_config).promise();

app.get("/healthCheck", (req, res) => {
  res.send("health check passed");
});

// Endpoint to add items to the cart
app.post("/addToCart", (req, res) => {
  const form = new formidable.IncomingForm();

  form.parse(req, async (err, fields) => {
    if (err) {
      console.error("Error parsing form data:", err);
      return res.status(500).json({ message: "Error parsing form data" });
    }

    const userEmail = fields.userEmail;
    const productId = fields.productId;
    const quantity = parseInt(fields.quantity, 10);

    try {
      const connection = await connection_pool.getConnection();

      // Get the UserID by email
      const [userResults] = await connection.query(
        "SELECT UserID FROM Users WHERE Email = ?",
        [userEmail]
      );
      if (userResults.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }
      const userId = userResults[0].UserID;

      // Check if the user has an existing cart
      const [cartResults] = await connection.query(
        "SELECT * FROM Cart WHERE UserID = ?",
        [userId]
      );
      let cartId;

      if (cartResults.length === 0) {
        // Create a new cart if it doesn't exist
        const [cartInsertResult] = await connection.query(
          "INSERT INTO Cart (UserID) VALUES (?)",
          [userId]
        );
        cartId = cartInsertResult.insertId;
      } else {
        cartId = cartResults[0].CartID;
      }

      // Check if the product already exists in the cart
      const [cartItemResults] = await connection.query(
        "SELECT * FROM CartItems WHERE CartID = ? AND ProductID = ?",
        [cartId, productId]
      );
      if (cartItemResults.length > 0) {
        // Update the quantity if it already exists
        await connection.query(
          "UPDATE CartItems SET Quantity = Quantity + ? WHERE CartID = ? AND ProductID = ?",
          [quantity, cartId, productId]
        );
      } else {
        // Add the product to the cart
        await connection.query(
          "INSERT INTO CartItems (CartID, ProductID, Quantity) VALUES (?, ?, ?)",
          [cartId, productId, quantity]
        );
      }

      connection.release();

      res.status(200).json({ message: "Product added to cart successfully" });
    } catch (error) {
      console.error("Error adding to cart:", error);
      res
        .status(500)
        .json({ error: "An error occurred while adding to the cart" });
    }
  });
});

app.get("/getCart", async (req, res) => {
  const userEmail = req.query.id;

  try {
    const connection = await connection_pool.getConnection();

    // Get the UserID by email
    const [userResults] = await connection.query(
      "SELECT UserID FROM Users WHERE Email = ?",
      [userEmail]
    );
    if (userResults.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const userId = userResults[0].UserID;

    // Get the cart for the user
    const [cartResults] = await connection.query(
      "SELECT CartID FROM Cart WHERE UserID = ?",
      [userId]
    );
    if (cartResults.length === 0) {
      return res.status(404).json({ error: "Cart not found for user" });
    }
    const cartId = cartResults[0].CartID;

    // Get the cart items
    const [cartItems] = await connection.query(
      `
      SELECT CartItems.*, Products.Name, Products.Price, Products.Images 
      FROM CartItems 
      JOIN Products ON CartItems.ProductID = Products.ProductID 
      WHERE CartItems.CartID = ?
    `,
      [cartId]
    );

    connection.release();

    res.status(200).json({ cartItems });
  } catch (error) {
    console.error("Error fetching cart items:", error);
    res
      .status(500)
      .json({ error: "An error occurred while fetching cart items" });
  }
});

app.post("/checkout", async (req, res) => {
  const form = new formidable.IncomingForm();

  form.parse(req, async (err, fields) => {
    if (err) {
      console.error("Error parsing form data:", err);
      return res.status(500).json({ message: "Error parsing form data" });
    }

    const userEmail = fields.userEmail;
    const addressId = fields.addressId; // Assuming the client sends the selected address ID

    try {
      const connection = await connection_pool.getConnection();

      // Start transaction
      await connection.beginTransaction();

      try {
        // Get the UserID by email
        const [userResults] = await connection.query(
          "SELECT UserID FROM Users WHERE Email = ?",
          [userEmail]
        );
        if (userResults.length === 0) {
          throw new Error("User not found");
        }
        const userId = userResults[0].UserID;

        // Get the cart for the user
        const [cartResults] = await connection.query(
          "SELECT CartID FROM Cart WHERE UserID = ?",
          [userId]
        );
        if (cartResults.length === 0) {
          throw new Error("Cart not found for user");
        }
        const cartId = cartResults[0].CartID;

        // Get cart items and validate stock
        const [cartItems] = await connection.query(
          `
          SELECT ci.ProductID, ci.Quantity, p.Price, p.StockQuantity
          FROM CartItems ci
          JOIN Products p ON ci.ProductID = p.ProductID
          WHERE ci.CartID = ?
        `,
          [cartId]
        );

        let totalAmount = 0;
        for (const item of cartItems) {
          if (item.Quantity > item.StockQuantity) {
            throw new Error(
              `Insufficient stock for product ID ${item.ProductID}`
            );
          }
          totalAmount += item.Price * item.Quantity;
        }

        // Create order
        const [orderResult] = await connection.query(
          "INSERT INTO Orders (UserID, TotalAmount, Status, AddressID) VALUES (?, ?, ?, ?)",
          [userId, totalAmount, "Pending", addressId]
        );
        const orderId = orderResult.insertId;

        // Create order items and update product stock
        for (const item of cartItems) {
          await connection.query(
            "INSERT INTO OrderItems (OrderID, ProductID, Quantity, Price) VALUES (?, ?, ?, ?)",
            [orderId, item.ProductID, item.Quantity, item.Price]
          );
          await connection.query(
            "UPDATE Products SET StockQuantity = StockQuantity - ? WHERE ProductID = ?",
            [item.Quantity, item.ProductID]
          );
        }

        // Clear cart
        await connection.query("DELETE FROM CartItems WHERE CartID = ?", [
          cartId,
        ]);

        // Commit transaction
        await connection.commit();

        res.status(200).json({ message: "Checkout successful", orderId });
      } catch (error) {
        // Rollback transaction in case of error
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error("Error during checkout:", error);
      res
        .status(500)
        .json({ error: error.message || "An error occurred during checkout" });
    }
  });
});

// Endpoint to update the quantity of an item in the cart
app.post("/updateCartQuantity", async (req, res) => {
  // const { userEmail, itemId, quantity } = req.body;
  const form = new formidable.IncomingForm();

  form.parse(req, async (err, fields) => {
    if (err) {
      console.error("Error parsing form data:", err);
      return res.status(500).json({ message: "Error parsing form data" });
    }

    const userEmail = fields.userEmail;
    const itemId = fields.itemId;
    const quantity = parseInt(fields.quantity, 10);
    try {
      const connection = await connection_pool.getConnection();

      // Get the UserID by email
      const [userResults] = await connection.query(
        "SELECT UserID FROM Users WHERE Email = ?",
        [userEmail]
      );
      if (userResults.length === 0) {
        connection.release();
        return res.status(404).json({ error: "User not found" });
      }
      const userId = userResults[0].UserID;

      // Get the CartID by UserID
      const [cartResults] = await connection.query(
        "SELECT CartID FROM Cart WHERE UserID = ?",
        [userId]
      );
      if (cartResults.length === 0) {
        connection.release();
        return res.status(404).json({ error: "Cart not found" });
      }
      const cartId = cartResults[0].CartID;

      // Update the quantity of the item in the cart
      const [updateResult] = await connection.query(
        "UPDATE CartItems SET Quantity = ? WHERE CartID = ? AND ProductID = ?",
        [quantity, cartId, itemId]
      );

      if (updateResult.affectedRows === 0) {
        connection.release();
        return res.status(404).json({ error: "Cart item not found" });
      }

      connection.release();

      res
        .status(200)
        .json({ message: "Cart item quantity updated successfully" });
    } catch (error) {
      console.error("Error updating cart quantity:", error);
      res
        .status(500)
        .json({ error: "An error occurred while updating the cart quantity" });
    }
  });
});

app.post("/getAdd", (req, res) => {
  const form = new formidable.IncomingForm();

  form.parse(req, async (err, fields) => {
    if (err) {
      console.error("Error parsing form data:", err);
      return res.status(500).json({ message: "Error parsing form data" });
    }

    const email = fields.userEmail;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    try {
      const connection = await connection_pool.getConnection();
      const [userResults] = await connection.query(
        "SELECT UserID FROM Users WHERE Email = ?",
        [email]
      );

      if (userResults.length === 0) {
        connection.release();
        return res.status(404).json({ message: "User not found" });
      }

      const userId = userResults[0].UserID;

      const [addressResults] = await connection.query(
        "SELECT * FROM Addresses WHERE UserID = ?",
        [userId]
      );
      connection.release();

      if (addressResults.length > 0) {
        res.status(200).json({ addresses: addressResults });
      } else {
        res
          .status(404)
          .json({ message: "No addresses found for the specified user" });
      }
    } catch (error) {
      console.error("Error fetching addresses:", error);
      res
        .status(500)
        .json({ error: "An error occurred while fetching addresses" });
    }
  });
});

app.get("/productsList", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const category = req.query.category;

  try {
    const connection = await connection_pool.getConnection();

    let categoryId = null;

    if (category) {
      const [categoryResult] = await connection.query(
        "SELECT CategoryID FROM Categories WHERE Name = ?",
        [category]
      );
      if (categoryResult.length > 0) {
        categoryId = categoryResult[0].CategoryID;
      } else {
        return res.status(404).json({ error: "Category not found" });
      }
    }

    let query = "SELECT * FROM Products";
    let countQuery = "SELECT COUNT(*) as total FROM Products";
    const params = [];
    const countParams = [];

    if (categoryId !== null) {
      query += " WHERE CategoryID = ?";
      countQuery += " WHERE CategoryID = ?";
      params.push(categoryId);
      countParams.push(categoryId);
    }

    query += " LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const [products] = await connection.query(query, params);
    const [countResult] = await connection.query(countQuery, countParams);
    const totalProducts = countResult[0].total;

    connection.release();

    res.json({
      products,
      currentPage: page,
      totalPages: Math.ceil(totalProducts / limit),
      totalProducts,
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    res
      .status(500)
      .json({ error: "An error occurred while fetching products" });
  }
});

app.get("/product", async (req, res) => {
  const productId = req.query.id;

  try {
    const connection = await connection_pool.getConnection();

    // Use parameterized query to prevent SQL injection
    let query = "SELECT * FROM Products WHERE ProductID = ?";

    const [results] = await connection.query(query, [productId]);
    connection.release();

    // Extract the single product from the results array
    const product = results.length > 0 ? results[0] : null;

    res.json({ product });
  } catch (error) {
    console.error("Error fetching products:", error);
    res
      .status(500)
      .json({ error: "An error occurred while fetching products" });
  }
});

app.post("/login", async (req, res) => {
  const form = new formidable.IncomingForm();
  form.parse(req, async (err, fields) => {
    if (err) {
      console.error("Error parsing form data:", err);
      return res.status(500).json({ message: "Error parsing form data" });
    }

    const email = fields.email[0]; // Access email as fields.email[0]
    const password = fields.password[0]; // Access password as fields.password[0]

    try {
      const connection = await connection_pool.getConnection();
      const [user] = await connection.query(
        "SELECT * FROM Users WHERE Email = ? AND BINARY Password = ?",
        [email, password]
      );
      connection.release();

      if (user.length > 0) {
        return res.status(200).json({ message: "Logged in successfully!" });
      } else {
        return res
          .status(401)
          .json({ message: "Please enter correct email / password!" });
      }
    } catch (error) {
      console.error("Error processing login request:", error);
      return res
        .status(500)
        .json({ message: "An error occurred while processing your request." });
    }
  });
});

app.post("/register", async (req, res) => {
  const form = new formidable.IncomingForm();
  form.parse(req, async (err, fields) => {
    if (err) {
      console.error("Error parsing form data:", err);
      return res.status(500).json({ message: "Error parsing form data" });
    }

    const name = fields.name;
    const password = fields.password;
    const email = fields.email;

    if (!name || !password || !email) {
      return res.status(400).json({ message: "Please fill out the form!" });
    }

    const normalizedEmail = email[0].toLowerCase();

    if (normalizedEmail.includes(" ")) {
      return res
        .status(400)
        .json({ message: "Email should not contain spaces!" });
    }

    const emailRegex = /^[^@]+@[^@]+\.[^@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email address!" });
    }

    try {
      const connection = await connection_pool.getConnection();
      const [account] = await connection.query(
        "SELECT * FROM Users WHERE LOWER(Email) = ?",
        [normalizedEmail]
      );

      if (account.length > 0) {
        connection.release();
        return res.status(400).json({ message: "Account already exists!" });
      }

      await connection.query(
        "INSERT INTO Users VALUES (NULL, ?, ?, ?, NULL, NULL, NULL, NULL)",
        [name, normalizedEmail, password]
      );
      connection.release();
      return res
        .status(200)
        .json({ message: "You have successfully registered!" });
    } catch (error) {
      console.error("Error processing registration request:", error);
      return res.status(500).json({
        message: "An error occurred while processing your request.",
        error: error.message,
      });
    }
  });
});
