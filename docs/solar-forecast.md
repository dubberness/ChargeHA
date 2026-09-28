# Solar Forecast

ChargeHA can fetch a solar production forecast for your roof and show it next to
what your system actually produced:

- **Dashboard** — today's forecast, how production is tracking against it, what
  is still to come, tomorrow's forecast, a today-and-tomorrow chart with the
  likely range, and a strip of daily totals for the week ahead.
- **Stats** — a forecast line over the day, month and year charts, the forecast
  total for the period, and **Actual vs Forecast** for the hours that have
  passed.

The forecast is display only. It does not change how charging is controlled.

## Providers

| Provider                       | Plan                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| [Solcast](https://solcast.com) | Free hobbyist plan: up to 2 rooftop sites and 10 API requests a day |

Forecast providers sit behind one interface
(`packages/server/src/services/forecast-providers/types.ts`), the same way
notification providers do, so another can be added without touching the service,
the database or the UI.

## Setup (Solcast)

1. Sign up at
   [solcast.com/free-rooftop-solar-forecasting](https://solcast.com/free-rooftop-solar-forecasting)
   as a home user.
2. Add your rooftop site — location, capacity, tilt and azimuth. An east/west
   split array is best added as two sites; ChargeHA adds them together.
3. Copy your API key from your Solcast account.
4. In ChargeHA, open **Settings → Solar Forecast**, choose **Solcast**, paste
   the key and press **Test Key**. The test lists the sites the key can see and
   does not use a request.
5. **Save.** The first forecast arrives within a minute.

**Site IDs** can stay blank to forecast every site on the account. Enter IDs
(comma-separated) to use only some of them.

The API key is stored in the database, encrypted at rest **only if
`ENCRYPTION_KEY` is set**, and is never sent back to the browser.

## Staying inside the daily limit

Each update costs one request per site. Listing sites (the key test) is free.
The quota resets at midnight UTC.

ChargeHA plans its updates from the forecast itself:

- Updates run only during daylight — the hours the forecast expects any
  production. Nothing is fetched at night.
- They are spread evenly from the start of daylight to its end. With the free
  plan's 10 requests and one site, that is 9 automatic updates a day — about 90
  minutes apart on a 12-hour day.
- One request is always held back so **Update now** in Settings still works.
- The count is kept in the database, so a restart never spends requests the day
  has already used. If Solcast reports the limit was reached anyway, no more
  requests are made until the reset.
- A failed update (network, Solcast busy) is retried after 15 minutes.
- A forecast older than 20 hours — for example after downtime — is refreshed
  straight away.

Accounts created before 2024 may have 50 requests a day. Set **Daily request
limit** to match and updates come more often, never closer than 15 minutes
apart.

## Actual vs forecast

Every stored forecast period keeps two values:

- **Latest** — the most recent forecast for that half-hour.
- **Day-ahead** — the forecast as it stood before that day began.

For hours that have passed, the dashboard and stats compare production with the
**day-ahead** forecast. The latest forecast for a half-hour that is already
underway is close to a measurement, so comparing against it would make any
forecast look accurate. Hours still to come use the latest forecast.

Only hours the forecast covers are compared. On the first day, the forecast
starts when it was first fetched, so the morning before that is left out of the
comparison and the chart leaves a gap there.

"Likely" ranges are Solcast's 10th and 90th percentiles — roughly a cloudier and
a clearer day than expected.

Forecasts are kept as long as energy readings (**Data retention** in Settings).

## Troubleshooting

### "Solcast rejected the API key"

The key was mistyped or regenerated. Use **Replace** in Settings → Solar
Forecast and test the new key.

### "Today's 10 requests are used"

Something used the day's quota — often a second system (such as Home Assistant)
sharing the same Solcast key. Updates resume after midnight UTC. Lower **Daily
request limit** if the key is shared, so ChargeHA only spends its share.

### "Solcast is busy"

Solcast returns this at busy times. ChargeHA only counts successful requests
against the quota, and retries after 15 minutes.
