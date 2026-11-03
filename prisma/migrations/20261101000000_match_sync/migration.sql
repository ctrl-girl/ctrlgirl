-- AlterTable
ALTER TABLE "Match" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Match" ADD COLUMN "syncedAt" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "Match_externalId_key" ON "Match"("externalId");
