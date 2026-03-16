ALTER TABLE "CustomField"
ADD COLUMN "order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "required" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "CustomField_projectId_order_idx" ON "CustomField"("projectId", "order");