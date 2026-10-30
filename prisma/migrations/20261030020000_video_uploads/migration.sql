CREATE TYPE "VideoStatus" AS ENUM ('UPLOADING', 'VERIFYING', 'UPLOADED', 'FAILED', 'CANCELED');
CREATE TABLE "Video" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "status" "VideoStatus" NOT NULL DEFAULT 'UPLOADING',
  "uploadKey" TEXT NOT NULL,
  "objectKey" TEXT,
  "etag" TEXT,
  "error" TEXT,
  "uploadExpiresAt" TIMESTAMP(3) NOT NULL,
  "verificationToken" UUID,
  "verificationStartedAt" TIMESTAMP(3),
  "uploadedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Video_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Video_sizeBytes_check" CHECK ("sizeBytes" > 0)
);
CREATE UNIQUE INDEX "Video_uploadKey_key" ON "Video"("uploadKey");
CREATE UNIQUE INDEX "Video_objectKey_key" ON "Video"("objectKey");
CREATE INDEX "Video_userId_createdAt_id_idx" ON "Video"("userId", "createdAt", "id");
CREATE INDEX "Video_status_uploadExpiresAt_idx" ON "Video"("status", "uploadExpiresAt");
ALTER TABLE "Video" ADD CONSTRAINT "Video_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
