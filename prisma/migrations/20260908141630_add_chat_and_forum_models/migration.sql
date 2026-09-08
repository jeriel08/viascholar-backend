-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "coordinator_user_id" INTEGER NOT NULL,
ADD COLUMN     "last_message_at" TIMESTAMP(3),
ADD COLUMN     "last_message_preview" TEXT,
ADD COLUMN     "scholar_user_id" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "meetings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "is_read" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "forum_posts" (
    "post_id" SERIAL NOT NULL,
    "author_user_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "content" TEXT NOT NULL,
    "category" VARCHAR(50) NOT NULL DEFAULT 'GENERAL',
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "views_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forum_posts_pkey" PRIMARY KEY ("post_id")
);

-- CreateTable
CREATE TABLE "forum_comments" (
    "comment_id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "author_user_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forum_comments_pkey" PRIMARY KEY ("comment_id")
);

-- CreateIndex
CREATE INDEX "forum_posts_category_idx" ON "forum_posts"("category");

-- CreateIndex
CREATE INDEX "forum_posts_created_at_idx" ON "forum_posts"("created_at");

-- CreateIndex
CREATE INDEX "forum_comments_post_id_idx" ON "forum_comments"("post_id");

-- CreateIndex
CREATE INDEX "conversations_scholar_user_id_idx" ON "conversations"("scholar_user_id");

-- CreateIndex
CREATE INDEX "conversations_coordinator_user_id_idx" ON "conversations"("coordinator_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_scholar_user_id_coordinator_user_id_key" ON "conversations"("scholar_user_id", "coordinator_user_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_idx" ON "messages"("conversation_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_scholar_user_id_fkey" FOREIGN KEY ("scholar_user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_coordinator_user_id_fkey" FOREIGN KEY ("coordinator_user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_comments" ADD CONSTRAINT "forum_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "forum_posts"("post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_comments" ADD CONSTRAINT "forum_comments_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
