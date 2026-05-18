-- CreateTable
CREATE TABLE "SprintMember" (
    "sprintId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SprintMember_pkey" PRIMARY KEY ("sprintId","userId")
);

-- CreateIndex
CREATE INDEX "SprintMember_userId_idx" ON "SprintMember"("userId");

-- AddForeignKey
ALTER TABLE "SprintMember" ADD CONSTRAINT "SprintMember_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "Sprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SprintMember" ADD CONSTRAINT "SprintMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
