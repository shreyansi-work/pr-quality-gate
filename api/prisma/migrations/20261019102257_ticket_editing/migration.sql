-- AlterEnum
ALTER TYPE "FindingSource" ADD VALUE 'MANUAL';

-- DropForeignKey
ALTER TABLE "Finding" DROP CONSTRAINT "Finding_firstRunId_fkey";

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "description" TEXT,
ADD COLUMN     "title" TEXT,
ALTER COLUMN "firstRunId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_firstRunId_fkey" FOREIGN KEY ("firstRunId") REFERENCES "PrRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
