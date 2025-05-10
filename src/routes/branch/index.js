const { Router } = require("express");
const branchController = require("../../controllers/branches");

const multer = require("multer");
const branchRouter = Router();

const storage = multer.memoryStorage();
const upload = multer({ storage });

branchRouter.get("/fetch", branchController.fetchBranches);
branchRouter.post("/create-scopes", branchController.createScopes);
branchRouter.get("/download/:id", branchController.downloadTemplate);
branchRouter.post("/regenerate-template", branchController.regenerateTemplate);
branchRouter.get("/fetch-templates", branchController.fetchTemplates);
branchRouter.delete("/delete-template", branchController.deleteTemplate);
branchRouter.post(
  "/upload",
  upload.single("file"),
  branchController.readScopesData
);
branchRouter.get("/download-data", branchController.downloadBranchData);
branchRouter.post("/add", branchController.addBranch);
branchRouter.delete("/delete", branchController.deleteBranch);
module.exports = branchRouter;
