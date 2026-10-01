CREATE TABLE `favorites` (
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `product_id`)
);
--> statement-breakpoint
CREATE TABLE `listings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`document` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_listings_owner` ON `listings` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_listings_status` ON `listings` (`status`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`offer_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_messages_offer` ON `messages` (`offer_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `offers` (
	`id` text PRIMARY KEY NOT NULL,
	`buyer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_title` text NOT NULL,
	`image` text NOT NULL,
	`unit` text NOT NULL,
	`quantity` integer NOT NULL,
	`price` integer NOT NULL,
	`shipping` text NOT NULL,
	`note` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sample` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_offers_buyer` ON `offers` (`buyer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_offers_seller` ON `offers` (`seller_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`company` text NOT NULL,
	`business_number` text NOT NULL,
	`phone` text NOT NULL,
	`region` text NOT NULL
);
