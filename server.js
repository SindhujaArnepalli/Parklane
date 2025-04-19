require("dotenv").config({ path: "./.env" });

const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI;
if (!uri) {
    console.error("❌ MONGO_URI is not defined in .env file");
    process.exit(1);
}

const client = new MongoClient(uri);
let db, usersCollection, menuCollection, tableCollection, eventCollection, cartCollection, orderCollection, offerCollection;
const verificationCodes = {};

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

async function connectDB() {
    try {
        await client.connect();
        db = client.db("RMS");
        usersCollection = db.collection("users");
        menuCollection = db.collection("menu");
        tableCollection = db.collection("tables");
        eventCollection = db.collection("eventHalls");
        cartCollection = db.collection("carts");
        orderCollection = db.collection("orders");
        offerCollection = db.collection("offers");
        console.log("✅ MongoDB is connected");

        // Verify menu collection data on startup
        const sampleItems = await menuCollection.find().limit(5).toArray();
        sampleItems.forEach(item => {
            console.log(`Startup Check - Item: ${item.name}, Price: ${item.price}, Type: ${typeof item.price}`);
        });
    } catch (err) {
        console.error("❌ DB Connection Error:", err);
        process.exit(1);
    }
}
connectDB();

// Authentication Routes
app.post("/signup", async (req, res) => {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) {
        return res.status(400).json({ message: "All fields are required." });
    }
    try {
        const existing = await usersCollection.findOne({ email });
        if (existing) return res.status(400).json({ message: "User already exists." });
        const hashed = await bcrypt.hash(password, 10);
        await usersCollection.insertOne({ name, email, phone, password: hashed });
        res.json({ message: "User registered successfully." });
    } catch (err) {
        console.error("Error during signup:", err);
        res.status(500).json({ message: "Server error during signup." });
    }
});

app.post("/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await usersCollection.findOne({ email });
        if (!user) return res.status(404).json({ message: "User not found." });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: "Incorrect password." });
        res.json({ message: "Login successful!", email: user.email, name: user.name });
    } catch (err) {
        console.error("Error during login:", err);
        res.status(500).json({ message: "Server error during login." });
    }
});

// OTP & Password Reset Routes
app.post("/forgot", async (req, res) => {
    const { email } = req.body;
    try {
        const user = await usersCollection.findOne({ email });
        if (!user) return res.status(404).json({ message: "Email not found." });
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        verificationCodes[email] = code;
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: "Password Reset Code",
            text: `Your password reset code is: ${code}`,
        });
        res.json({ message: "Verification code sent." });
    } catch (err) {
        console.error("Error sending reset code:", err);
        res.status(500).json({ message: "Server error sending reset code." });
    }
});

app.post("/change-password", async (req, res) => {
    const { email, code, newPassword } = req.body;
    try {
        if (!verificationCodes[email] || verificationCodes[email] !== code) {
            return res.status(400).json({ message: "Invalid or expired code." });
        }
        const hashed = await bcrypt.hash(newPassword, 10);
        const result = await usersCollection.updateOne({ email }, { $set: { password: hashed } });
        if (result.modifiedCount === 0) {
            return res.status(404).json({ message: "User not found or no changes made." });
        }
        delete verificationCodes[email];
        res.json({ message: "Password reset successful." });
    } catch (err) {
        console.error("Error resetting password:", err);
        res.status(500).json({ message: "Server error resetting password." });
    }
});

app.post("/send-code", async (req, res) => {
    const { email } = req.body;
    try {
        const user = await usersCollection.findOne({ email });
        if (!user) return res.status(404).json({ message: "Email not registered." });
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        verificationCodes[email] = code;
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: "Your OTP Code",
            text: `Your verification code is: ${code}`,
        });
        res.json({ message: "OTP sent successfully." });
    } catch (err) {
        console.error("Error sending OTP:", err);
        res.status(500).json({ message: "Server error sending OTP." });
    }
});

app.post("/verify-code", async (req, res) => {
    const { email, code } = req.body;
    try {
        if (verificationCodes[email] !== code) {
            return res.status(400).json({ message: "Invalid or expired code." });
        }
        delete verificationCodes[email];
        res.json({ message: "Code verified successfully." });
    } catch (err) {
        console.error("Error verifying code:", err);
        res.status(500).json({ message: "Server error verifying code." });
    }
});

// Menu & Resources Routes with Offers
app.get("/menu", async (req, res) => {
    try {
        const menuItems = await menuCollection.find().toArray();
        const offers = await offerCollection.find().toArray();

        
        const offersMap = offers.reduce((acc, offer) => {
            const offerPrice = Number(offer.offerPrice); // Clean offer price
            if (!isNaN(offerPrice) && offerPrice > 0) {
                acc[offer.itemId.toString()] = offerPrice;
            } else {
                console.warn(`Invalid offer price for item ${offer.itemId}: ${offer.offerPrice}`);
            }
            return acc;
        }, {});

        const menuWithOffers = menuItems.map(item => {
            // Clean the price by removing non-numeric characters
            const rawPrice = item.price || "0";
            const price = Number(rawPrice.toString().replace(/[^0-9.-]+/g, ""));

            const offerPrice = offersMap[item._id.toString()] || null;


            if (isNaN(price) || price <= 0) {
                console.error(`Invalid price for item ${item.name}: ${rawPrice}, _id: ${item._id}, using 0`);
                return { ...item, price: 0, offerPrice: null };
            }

            return {
                ...item,
                price,
                offerPrice: offerPrice !== null && !isNaN(offerPrice) && offerPrice > 0 ? offerPrice : null
            };
        });

        res.json(menuWithOffers);
    } catch (err) {
        console.error("Error fetching menu:", err);
        res.status(500).json({ message: "Server error fetching menu." });
    }
});

app.get("/menu/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const item = await menuCollection.findOne({ _id: new ObjectId(id) });
        if (!item) return res.status(404).json({ message: "Menu item not found." });
        const offer = await offerCollection.findOne({ itemId: new ObjectId(id) });
        const rawPrice = item.price || "0";
        const price = Number(rawPrice.toString().replace(/[^0-9.-]+/g, ""));

        if (isNaN(price) || price <= 0) {
            console.error(`Invalid price for item ${item.name}: ${rawPrice}, _id: ${item._id}`);
            return res.status(400).json({ message: `Invalid price for ${item.name}` });
        }

        res.json({
            ...item,
            price,
            offerPrice: offer ? Number(offer.offerPrice.replace(/[^0-9.-]+/g, "")) : null
        });
    } catch (err) {
        console.error("Error fetching menu item:", err);
        res.status(500).json({ message: "Server error fetching menu item." });
    }
});

app.get("/tables", async (req, res) => {
    try {
        const tables = await tableCollection.find().toArray();
        res.json(tables);
    } catch (err) {
        console.error("Error fetching tables:", err);
        res.status(500).json({ message: "Server error fetching tables." });
    }
});

app.get("/eventhalls", async (req, res) => {
    try {
        const halls = await eventCollection.find().toArray();
        res.json(halls);
    } catch (err) {
        console.error("Error fetching event halls:", err);
        res.status(500).json({ message: "Server error fetching event halls." });
    }
});

// Cart API with Offers
app.post("/cart/add", async (req, res) => {
    const { email, itemId, name, price } = req.body;

    if (!email || !itemId || !name || price == null) {
        return res.status(400).json({ message: "Missing or invalid item data" });
    }

    try {
        const offer = await offerCollection.findOne({ itemId: new ObjectId(itemId) });
        const effectivePrice = offer && !isNaN(Number(offer.offerPrice.replace(/[^0-9.-]+/g, ""))) && Number(offer.offerPrice.replace(/[^0-9.-]+/g, "")) > 0
            ? Number(offer.offerPrice.replace(/[^0-9.-]+/g, ""))
            : Number(price);

        if (isNaN(effectivePrice) || effectivePrice <= 0) {
            return res.status(400).json({ message: "Invalid price value" });
        }

        let userCart = await cartCollection.findOne({ email });

        if (userCart) {
            const itemIndex = userCart.items.findIndex(item => item._id === itemId);
            if (itemIndex > -1) {
                userCart.items[itemIndex].quantity += 1;
            } else {
                userCart.items.push({ _id: itemId, name, price: effectivePrice, quantity: 1 });
            }
            userCart.totalCost = userCart.items.reduce(
                (acc, item) => acc + (item.price * item.quantity),
                0
            );
            await cartCollection.updateOne(
                { email },
                { $set: { items: userCart.items, totalCost: userCart.totalCost } },
                { upsert: true }
            );
        } else {
            const newCart = {
                email,
                items: [{ _id: itemId, name, price: effectivePrice, quantity: 1 }],
                totalCost: effectivePrice
            };
            await cartCollection.insertOne(newCart);
        }

        const updatedCart = await cartCollection.findOne({ email });
        if (!updatedCart) {
            return res.status(500).json({ message: "Failed to save cart" });
        }

        res.json({ success: true, message: "Item added successfully", cart: updatedCart });
    } catch (error) {
        console.error("Error in /cart/add:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.get("/cart/:email", async (req, res) => {
    const email = req.params.email;
    try {
        const userCart = await cartCollection.findOne({ email });
        if (!userCart) {
            return res.json({ items: [], totalCost: 0 });
        }
        res.json({ items: userCart.items, totalCost: userCart.totalCost });
    } catch (error) {
        console.error("Error fetching cart:", error);
        res.status(500).json({ message: "Error fetching cart", error });
    }
});

app.put("/cart/:email/:itemId", async (req, res) => {
    const { email, itemId } = req.params;
    const { change } = req.body;
  
    try {
      const userCart = await cartCollection.findOne({ email });
      if (!userCart) {
        return res.status(404).json({ message: "Cart not found" });
      }
  
      const itemIndex = userCart.items.findIndex(item => item._id.toString() === itemId); // Ensure string comparison
      if (itemIndex === -1) {
        return res.status(404).json({ message: "Item not in cart" });
      }
  
      const item = userCart.items[itemIndex];
      const newQty = item.quantity + change;
  
      if (newQty <= 0) {
        userCart.items.splice(itemIndex, 1);
        userCart.totalCost -= item.price * item.quantity;
      } else {
        userCart.items[itemIndex].quantity = newQty;
        userCart.totalCost += item.price * change;
      }
  
      await cartCollection.updateOne(
        { email },
        { $set: { items: userCart.items, totalCost: userCart.totalCost } },
        { upsert: true } // Allow upsert to create cart if it doesn't exist
      );
      res.json({ message: "Cart updated" });
    } catch (error) {
      console.error("Error updating cart:", error);
      res.status(500).json({ message: "Error updating cart", error: error.message });
    }
  });

//offers
app.get("/offers", async (req, res) => {
    try {
        const offers = await offerCollection.find().toArray();
        if (offers.length === 0) {
            return res.json([]);
        }

        // Fetch corresponding menu items to get images
        const offerItemIds = offers.map(offer => new ObjectId(offer.itemId));
        const menuItems = await menuCollection.find({ _id: { $in: offerItemIds } }).toArray();

        // Create a map of menu items by _id for easy lookup
        const menuMap = menuItems.reduce((acc, item) => {
            acc[item._id.toString()] = item;
            return acc;
        }, {});

        // Enrich offers with image data from menu items
        const enrichedOffers = offers.map(offer => {
            const menuItem = menuMap[offer.itemId.toString()];
            const originalPrice = parseFloat(offer.originalPrice.replace('₹', '')) || 0;
            const offerPrice = parseFloat(offer.offerPrice) || 0;
            const imagePath = menuItem && menuItem.image ? menuItem.image : "/images/placeholder.jpg";
            return {
                _id: offer._id,
                itemName: offer.itemName || (menuItem ? menuItem.name : "Unknown Item"),
                originalPrice: `₹${originalPrice.toFixed(2)}`,
                offerPrice: `₹${offerPrice.toFixed(2)}`,
                image: imagePath
            };
        });

        res.json(enrichedOffers);
    } catch (err) {
        console.error("Error fetching offers:", err);
        res.status(500).json({ message: "Server error fetching offers." });
    }
});

// Order API
app.post("/order", async (req, res) => {
    const { email } = req.body;
    try {
        const cart = await cartCollection.findOne({ email });
        if (!cart || !cart.items.length) return res.status(400).json({ message: "Cart is empty." });

        const orderItems = cart.items;
        const total = orderItems.reduce((acc, item) => acc + (item.price * item.quantity), 0);

        await orderCollection.insertOne({ email, items: orderItems, total, createdAt: new Date() });
        await cartCollection.deleteOne({ email });
        res.json({ message: "Order placed successfully." });
    } catch (err) {
        console.error("Error placing order:", err);
        res.status(500).json({ message: "Server error placing order." });
    }
});

app.get("/orders/:email", async (req, res) => {
    const userEmail = req.params.email;

    if (!userEmail) {
        return res.status(400).json({ message: "Email parameter is missing" });
    }

    try {
        const orders = await orderCollection.find({ email: userEmail }).toArray();
        if (!orders || orders.length === 0) {
            return res.json([]);
        }
        res.json(orders);
    } catch (err) {
        console.error("Error fetching user orders:", err);
        res.status(500).json({ message: "Failed to fetch orders" });
    }
});

// Logout
app.post("/logout", (req, res) => {
    res.json({ message: "Logout successful." });
});

// Server Start
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});