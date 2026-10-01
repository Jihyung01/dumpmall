CREATE TABLE IF NOT EXISTS "favorites" (
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	PRIMARY KEY("user_id", "product_id")
);

CREATE TABLE IF NOT EXISTS "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"document" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_listings_owner" ON "listings" ("owner_id");
CREATE INDEX IF NOT EXISTS "idx_listings_status" ON "listings" ("status");
CREATE TABLE IF NOT EXISTS "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"offer_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_messages_offer" ON "messages" ("offer_id","created_at");
CREATE TABLE IF NOT EXISTS "offers" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_title" text NOT NULL,
	"image" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" integer NOT NULL,
	"price" integer NOT NULL,
	"shipping" text NOT NULL,
	"note" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sample" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_offers_buyer" ON "offers" ("buyer_id","created_at");
CREATE INDEX IF NOT EXISTS "idx_offers_seller" ON "offers" ("seller_id","created_at");
CREATE TABLE IF NOT EXISTS "profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"company" text NOT NULL,
	"business_number" text NOT NULL,
	"phone" text NOT NULL,
	"region" text NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, content_type TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS business_address TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS district_key TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS public_alias TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS alias_version INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_public_alias ON profiles(public_alias);
CREATE TABLE IF NOT EXISTS alias_counters (
  district_key TEXT PRIMARY KEY,
  next_slot INTEGER NOT NULL CHECK (next_slot > 0)
);

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS payout_bank TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS payout_account TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS payout_holder TEXT;
CREATE TABLE IF NOT EXISTS auctions (
  listing_id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL,
  start_price INTEGER NOT NULL CHECK (start_price > 0),
  reserve_price INTEGER NOT NULL CHECK (reserve_price > 0),
  current_price INTEGER,
  current_bidder_id TEXT,
  bid_count INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT NOT NULL,
  midpoint_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  midpoint_alerted_at TEXT,
  extended_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  close_reason TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auctions_status_ends ON auctions(status, ends_at);
CREATE INDEX IF NOT EXISTS idx_auctions_seller ON auctions(seller_id);
CREATE TABLE IF NOT EXISTS bids (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  bidder_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bids_listing ON bids(listing_id, amount DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_bids_bidder ON bids(bidder_id, created_at);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  product_title TEXT NOT NULL,
  image TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  fee_rate INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  net INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  depositor TEXT,
  payment_due_at TEXT NOT NULL,
  reported_at TEXT,
  paid_at TEXT,
  shipped_at TEXT,
  completed_at TEXT,
  settled_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, payment_due_at);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'whole';
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS min_lot INTEGER NOT NULL DEFAULT 1 CHECK (min_lot > 0);
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS sold_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS unsold_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS last_bid_id TEXT;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS close_token TEXT;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS reserve_met_at TEXT;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS succession_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS succession_until TEXT;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS relisted_to TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS relisted_to TEXT;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS quantity INTEGER CHECK (quantity > 0);
ALTER TABLE bids ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE bids ADD COLUMN IF NOT EXISTS allocated_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS lost_reason TEXT;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS replaced_at TEXT;
ALTER TABLE bids ADD COLUMN IF NOT EXISTS replaced_by TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bids_one_active_partial ON bids(listing_id, bidder_id) WHERE status='active' AND quantity IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bids_listing_status ON bids(listing_id, status, amount DESC, created_at, id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bid_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bid_quantity INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS batch_token TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS succession_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS parent_order_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS succession_token TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS succession_at TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS offer_expires_at TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_open_deposit_code ON orders(deposit_code) WHERE status IN ('awaiting_payment','payment_reported','offered');
CREATE INDEX IF NOT EXISTS idx_orders_listing_status ON orders(listing_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_open_amount ON orders(amount) WHERE status IN ('awaiting_payment','payment_reported');
CREATE INDEX IF NOT EXISTS idx_orders_succession_sweep ON orders(cancelled_at) WHERE status='cancelled' AND succession_token IS NULL;
UPDATE orders SET succession_token='legacy' WHERE status='cancelled' AND succession_token IS NULL;
UPDATE auctions a SET sold_quantity=a.quantity, unsold_quantity=0 WHERE a.status='won' AND a.sold_quantity=0 AND a.unsold_quantity=0 AND EXISTS (SELECT 1 FROM orders o WHERE o.listing_id=a.listing_id AND o.status<>'cancelled');
UPDATE auctions a SET sold_quantity=0, unsold_quantity=a.quantity WHERE a.status IN ('won','unsold') AND a.sold_quantity=0 AND a.unsold_quantity=0 AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.listing_id=a.listing_id AND o.status<>'cancelled');
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  depositor TEXT NOT NULL,
  depositor_key TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  occurred_at TEXT,
  raw TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  reason TEXT,
  order_id TEXT,
  candidates TEXT,
  note TEXT,
  received_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_event ON deposits(provider, event_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status, received_at DESC);
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS last_failed_at TEXT;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS relisted_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS instant_price INTEGER CHECK (instant_price > 0);
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS decision_stage TEXT;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS decision_due_at TEXT;
CREATE INDEX IF NOT EXISTS idx_auctions_deciding ON auctions(decision_due_at) WHERE status='deciding';
ALTER TABLE bids ADD COLUMN IF NOT EXISTS ip_hash TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS offer_kind TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_photos TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS auto_complete_at TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TEXT;
UPDATE orders SET offer_kind='succession' WHERE offer_kind IS NULL AND succession_round > 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_paid INTEGER NOT NULL DEFAULT 0;
UPDATE orders SET refund_paid=refund_amount WHERE refunded_at IS NOT NULL AND refund_paid=0 AND refund_amount > 0;
UPDATE orders SET auto_complete_at=to_char((now() AT TIME ZONE 'UTC') + interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  WHERE status='shipped' AND auto_complete_at IS NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS business_status TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS business_checked_at TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS business_number_since TEXT;
UPDATE profiles SET business_number_since='1970-01-01T00:00:00.000Z' WHERE business_number_since IS NULL;
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  opener_role TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  photos TEXT,
  response TEXT,
  response_photos TEXT,
  responded_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  refund_amount INTEGER NOT NULL DEFAULT 0,
  penalty_party TEXT,
  penalty_user_id TEXT,
  penalty_amount INTEGER NOT NULL DEFAULT 0,
  penalty_status TEXT NOT NULL DEFAULT 'none',
  admin_note TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  penalty_settled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_one_open ON disputes(order_id) WHERE status='open';
CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_one_nopay ON disputes(order_id) WHERE kind='no_payment';
CREATE INDEX IF NOT EXISTS idx_disputes_penalty ON disputes(penalty_user_id, penalty_status);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status, created_at DESC);
CREATE TABLE IF NOT EXISTS activity_ips (
  user_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, ip_hash)
);
CREATE INDEX IF NOT EXISTS idx_activity_ips_hash ON activity_ips(ip_hash);
