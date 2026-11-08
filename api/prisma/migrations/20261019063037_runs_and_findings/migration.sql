-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "FindingSource" AS ENUM ('CHECK', 'AI', 'RULE');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('NEW', 'ACCEPTED', 'HELD', 'REJECTED');

-- AlterTable
ALTER TABLE "Repo" ADD COLUMN     "installationId" INTEGER;

-- CreateTable
CREATE TABLE "PrRun" (
    "id" SERIAL NOT NULL,
    "pullRequestId" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "model" TEXT,
    "changedFiles" JSONB,
    "skippedFiles" JSONB,
    "ciSummary" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" SERIAL NOT NULL,
    "pullRequestId" INTEGER NOT NULL,
    "firstRunId" INTEGER NOT NULL,
    "lastSeenRunId" INTEGER,
    "fingerprint" TEXT NOT NULL,
    "source" "FindingSource" NOT NULL,
    "category" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "file" TEXT NOT NULL,
    "functionName" TEXT,
    "quote" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "suggestedFix" TEXT,
    "confidence" TEXT,
    "status" "FindingStatus" NOT NULL DEFAULT 'NEW',
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrRun_pullRequestId_headSha_key" ON "PrRun"("pullRequestId", "headSha");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_pullRequestId_fingerprint_key" ON "Finding"("pullRequestId", "fingerprint");

-- AddForeignKey
ALTER TABLE "PrRun" ADD CONSTRAINT "PrRun_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_firstRunId_fkey" FOREIGN KEY ("firstRunId") REFERENCES "PrRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
