CREATE TABLE `solar_forecasts` (
	`period_start` text PRIMARY KEY NOT NULL,
	`period_minutes` integer NOT NULL,
	`pv_estimate_w` real NOT NULL,
	`pv_estimate10_w` real NOT NULL,
	`pv_estimate90_w` real NOT NULL,
	`day_ahead_w` real,
	`fetched_at` text NOT NULL
);
