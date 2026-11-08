-- CreateEnum
CREATE TYPE "TicketState" AS ENUM ('OPEN', 'NEEDS_LOOK', 'FIXED_AUTO', 'FIXED_MANUAL');

-- AlterEnum
ALTER TYPE "FindingStatus" ADD VALUE 'GONE';

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "closeReason" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "ticketState" "TicketState",
ADD COLUMN     "triagedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Finding_pullRequestId_status_idx" ON "Finding"("pullRequestId", "status");
