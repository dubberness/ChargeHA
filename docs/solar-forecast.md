# Solar Forecast

ChargeHA can fetch a solar production forecast for your roof and show it next to
what your system actually produced:

- **Dashboard** — today's forecast, how production is tracking against it, what
  is still to come, tomorrow's forecast, a today-and-tomorrow chart with the
  likely range, and a strip of daily totals for the week ahead.
- **Stats** — a forecast line over the day, month and year charts, the forecast
  total for the period, and **Actual vs Forecast** for the hours that have
  passed.

- **Adjusted to your system** — the forecast learns how your roof actually
  compares with it, hour by hour, and corrects itself (below).
- **System check** — a warning, and optionally a notification, when your panels
  make well under their usual output on several clear days.

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

## Adjusted to your system

A forecast service knows your roof only from the location, size, tilt and
direction you gave it. It cannot see a tree that shades the panels until 9 am, a
neighbour's roof in the late afternoon, dust, or a tilt entered slightly wrong.
ChargeHA learns these from your own history.

Once a day, just after midnight, it compares the last **21 days** of what each
hour of the day actually produced with the **day-ahead** forecast for it, and
works out a factor for each hour — say 0.7 at 7 am (shaded) and 1.0 at noon.
Displayed forecasts are multiplied by these factors: the dashboard, the chart,
the daily totals and the Stats forecast line.

- It needs **7 days** of history before it does anything. Until then Settings →
  Solar Forecast shows "Learning — 3 of 7 days so far".
- Only hours with full readings count, so downtime does not teach it that the
  roof produces nothing.
- Hours are compared by total energy over the 21 days, so sunny days count most.
  A cloudy day the forecast got wrong adds little, and misses in both directions
  mostly cancel out.
- Hours with little history stay close to 1, and every factor stays between 0.3
  and 1.5.
- Three weeks is short enough to follow the sun's path through the seasons as
  shade moves.

Settings shows the hours it adjusts by 5% or more. Turn **Adjust to my system**
off to see the provider's forecast unchanged. Learning carries on either way, so
turning it back on takes effect straight away.

This is like the dampening option in the Home Assistant Solcast integration,
except the factors are learned rather than set by hand.

## System check

Once a day ChargeHA also checks that the panels are producing what they usually
do. Weather makes a single day meaningless, so it only uses **clear days**: days
the forecast made during the day expected most of what the sunniest recent day
did, and was confident about it (a narrow likely range).

- On each clear day it takes production as a share of that day's forecast.
- It compares the **3 most recent** clear days (within the last 10 days) with
  the **usual** share: the median over clear days in the 45 days before them.
- If all 3 recent clear days come in under **75%** of the usual, the check turns
  **Low**. The dashboard shows a warning, and the **Solar Underperforming**
  notification is sent, once, if it is turned on in Settings → Notifications.
- Days with gaps in the readings are left out.

Because it compares your system with its own usual, it does not matter if the
forecast always runs high or low for your roof. It needs about six clear days of
history before it can say anything; until then it shows **Waiting**.

A low result usually means an inverter fault (a string or optimiser down), dirty
panels, or new shade. Once it has been low for over a month the low days become
the new usual, so fix it or check it when it first shows.

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
