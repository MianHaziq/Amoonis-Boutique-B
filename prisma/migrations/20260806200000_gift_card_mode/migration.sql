-- CreateEnum
CREATE TYPE "GiftCardMode" AS ENUM ('MESSAGE', 'NAME');

-- AlterTable
-- Nullable everywhere so every existing row is unchanged: null resolves to the
-- historical MESSAGE (personalized note) behavior. Product/Category hold the config
-- (product ?? category ?? MESSAGE); CartItem/OrderItem hold the resolved snapshot used
-- to label the value as "Gift name" vs "Gift message".
ALTER TABLE "Product" ADD COLUMN     "giftCardMode" "GiftCardMode";
ALTER TABLE "Category" ADD COLUMN     "giftCardMode" "GiftCardMode";
ALTER TABLE "CartItem" ADD COLUMN     "giftCardMode" "GiftCardMode";
ALTER TABLE "OrderItem" ADD COLUMN     "giftCardMode" "GiftCardMode";
