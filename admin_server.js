require("dotenv").config({ path: "./.env" });

const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.ADMIN_PORT || 5001; // Different port for admin server

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
        usersCollection = db.collection("parkingdetails");
        console.log("✅ MongoDB is connected");
    } catch (err) {
        console.error("❌ DB Connection Error:", err);
        process.exit(1);
    }
}
connectDB();

// Middleware to check if user is admin
const isAdmin = async (req, res, next) => {
    const email = req.headers["x-admin-email"] || req.query.email || req.body.email; // Check headers, query, or body
    if (!email) {
        return res.status(403).json({ message: "Access denied. Admin email is required." });
    }
    const user = await usersCollection.findOne({ email });
    if (!user || !user.isAdmin) {
        return res.status(403).json({ message: "Access denied. Admin only." });
    }
    req.user = user; // Attach user to request for later use if needed
    next();
};

// Admin Signup Route
app.post("/admin/signup", async (req, res) => {
    const { name, email, phone, password, adminCode } = req.body;

    // Simple admin code check (replace with a secure method in production)
    const SECRET_ADMIN_CODE = process.env.ADMIN_CODE || "ADMIN123";
    if (adminCode !== SECRET_ADMIN_CODE) {
        return res.status(403).json({ message: "Invalid admin code." });
    }

    if (!name || !email || !phone || !password) {
        return res.status(400).json({ message: "All fields are required." });
    }

    const existing = await usersCollection.findOne({ email });
    if (existing) {
        return res.status(400).json({ message: "User already exists." });
    }

    const hashed = await bcrypt.hash(password, 10);
    const adminUser = {
        name,
        email,
        phone,
        password: hashed,
        isAdmin: true // Set admin flag
    };

    try {
        await usersCollection.insertOne(adminUser);
        res.json({ message: "Admin registered successfully." });
    } catch (err) {
        console.error("Error registering admin:", err);
        res.status(500).json({ message: "Server error during signup." });
    }
});

// Admin Login Route
app.post("/admin/login", async (req, res) => {
    const { email, password } = req.body;
    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found." });
    if (!user.isAdmin) return res.status(403).json({ message: "Not an admin." });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: "Incorrect password." });
    res.json({ message: "Admin login successful!", email: user.email, name: user.name });
});

// Admin OTP & Password Reset Routes
app.post("/admin/forgot", async (req, res) => {
    const { email } = req.body;
    const user = await usersCollection.findOne({ email });
    if (!user || !user.isAdmin) return res.status(404).json({ message: "Admin email not found." });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes[email] = code;
    await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "Admin Password Reset Code",
        text: `Your password reset code is: ${code}`,
    });
    res.json({ message: "Verification code sent." });
});

app.post("/admin/change-password", async (req, res) => {
    const { email, code, newPassword } = req.body;
    if (verificationCodes[email] !== code) {
        return res.status(400).json({ message: "Invalid or expired code." });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await usersCollection.updateOne({ email, isAdmin: true }, { $set: { password: hashed } });
    delete verificationCodes[email];
    res.json({ message: "Password reset successful." });
});











// Admin Logout Route
app.post("/admin/logout", (req, res) => {
    res.json({ message: "Admin logout successful." });
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Admin Server running on port ${PORT}`);
});