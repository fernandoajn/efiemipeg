CREATE TYPE "ProcessingStatus" AS ENUM ('QUEUED', 'PROCESSING', 'READY', 'FAILED');
ALTER TABLE "Video"
  ADD COLUMN "processingStatus" "ProcessingStatus",
  ADD COLUMN "processingProgress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processingError" TEXT,
  ADD COLUMN "processingToken" UUID,
  ADD COLUMN "processingHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN "mediaVersion" UUID,
  ADD COLUMN "mediaPrefix" TEXT,
  ADD COLUMN "durationSeconds" DOUBLE PRECISION,
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER,
  ADD COLUMN "videoCodec" TEXT,
  ADD COLUMN "audioCodec" TEXT,
  ADD COLUMN "renditions" JSONB,
  ADD COLUMN "processedAt" TIMESTAMP(3),
  ADD CONSTRAINT "Video_processingProgress_check" CHECK ("processingProgress" BETWEEN 0 AND 100);
CREATE UNIQUE INDEX "Video_mediaPrefix_key" ON "Video"("mediaPrefix");
CREATE INDEX "Video_processingStatus_processingHeartbeatAt_idx" ON "Video"("processingStatus", "processingHeartbeatAt");
-- Originals verified before this phase join the queue; the worker's sweep picks them up.
UPDATE "Video" SET "processingStatus" = 'QUEUED' WHERE "status" = 'UPLOADED';
