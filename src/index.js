const apiRouter = require("./routes");
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const path = require("path");
const cleanupService = require("./services/cleanupService");

// Load environment variables as early as possible
dotenv.config();

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "https://ms.iriscommunications.cloud",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
  })
);

// Increase JSON body parser limit to 50MB
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const PORT = process.env.PORT || 8000;

app.use("/api", apiRouter);

// Define the directory for your files
const filesDirectory = path.join(__dirname, "files");

// Endpoint to download a specific file
app.get("/download/:fileName", (req, res) => {
  const { fileName } = req.params;

  // Construct the full file path
  const filePath = path.join(filesDirectory, fileName);

  // Send the file for download
  res.download(filePath, fileName, (err) => {
    if (err) {
      console.error("Error during file download:", err.message);
      res.status(404).send("File not found!");
    }
  });
});

app.get("/", (request, res) => {
  res.json("server running");
});

app.get("/test", (request, res) => {
  res.json("server running too faast");
});

// Add a health check endpoint for monitoring
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    cleanupService: cleanupService.getStatus(),
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Start the cleanup service to run every 15 minutes
  cleanupService.start(15);
  console.log(
    "Cleanup service started - will remove expired password reset tokens every 15 minutes"
  );
});
