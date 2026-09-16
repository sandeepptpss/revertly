-- VIP discounts are offers the merchant must claim before they apply.
-- NULL means unclaimed. Existing VIP grants (if any) are back-filled as
-- already claimed so nobody loses a discount they were told they had.
ALTER TABLE `StoreDiscount`
  ADD COLUMN `claimedAt` DATETIME(3) NULL;

UPDATE `StoreDiscount` SET `claimedAt` = `createdAt` WHERE `tier` = 'VIP';
