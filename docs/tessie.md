# Tessie Integration

[Tessie](https://tessie.com) is a paid Tesla companion service. It already holds
a paired virtual key for your car and keeps its own connection to Tesla, so
ChargeHA can control charging through Tessie's API with a single access token.

It is an alternative to the [Tesla Fleet API integration](tesla.md), not an
addition: use one or the other for a given car.

## When to choose Tessie over the Fleet API

|                   | Tesla (Fleet API)                                                                 | Tessie                                             |
| ----------------- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| Setup             | Developer app, key pair, public key hosting, partner registration, OAuth, pairing | One API token                                      |
| Internet exposure | Public key domain during pairing                                                  | None                                               |
| Command proxy     | `tesla-http-proxy` on `localhost:4443`                                            | Not used — Tessie signs commands                   |
| Cost              | Per call against Tesla's US$10/month credit                                       | Your Tessie subscription; no per-call charges      |
| Polling           | Cost-tuned: 10–20 min while idle, wakes budgeted                                  | At most once a minute, never wakes the car to read |
| Third party       | None                                                                              | Tessie sees your vehicle data and commands         |

The Fleet API path keeps everything between ChargeHA and Tesla. Tessie trades a
third party and a subscription for a much simpler setup and fresher data.

## Setup

1. Have an active Tessie subscription with your car added to it.
2. In Tessie, open [Settings → API](https://dash.tessie.com/settings/api) and
   choose **Generate Access Token**.
3. In ChargeHA, pick **Tesla (via Tessie)** as the vehicle type in the setup
   wizard, or add it later from Settings → Vehicles.
4. **Tessie API Token** — paste the token and press **Test Token**. The test
   lists your Tessie vehicles, so a pass means the token works.
5. **Vehicle Selection** — pick the cars ChargeHA should manage. With more than
   one, the priority orders solar allocation.

That is the whole setup. There is no key pairing step: Tessie's own virtual key
is already on the car.

The token is stored in the database, encrypted at rest **only if
`ENCRYPTION_KEY` is set** — the same as the Fleet API credentials.

If a car is currently set up through the Tesla (Fleet API) integration, remove
it there before adding it through Tessie. Both integrations identify a car by
its VIN.

## How ChargeHA uses the API

| When                                | Call                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| Controller tick, state < 1 min      | Nothing — served from cache                           |
| Controller tick, state ≥ 1 min      | `GET /{vin}/state`                                    |
| Start / stop / set amps             | `POST /{vin}/command/...`                             |
| After a start, or a refused command | `GET /{vin}/state` on the next tick                   |
| Dashboard refresh                   | `GET /{vin}/state`, plus `POST /{vin}/wake` if asleep |

`/state` returns Tessie's last-known state and never wakes the car. For a
sleeping car that is the state it went to sleep with, which is still true —
plugging in wakes the car, and Tessie picks that up on its own.

Commands are sent with `wait_for_completion=true`. Tessie wakes a sleeping car
itself and retries, so ChargeHA does not wake the car before a command.

## Min amps

Same as the Tesla integration: set **Min amps** per car under Settings →
Vehicles → Tessie. The range is 1–5A, default 5A. See
[Min amps](tesla.md#min-amps) for the caveats — they are properties of the car,
not the API.

## Troubleshooting

### "Tessie rejected the API token"

The token was revoked or mistyped. Generate a new one in Tessie and use
**Replace** under Settings → Vehicles → Tessie. The dashboard warning and the
command lock clear on the next successful request.

### "No active vehicles on your Tessie account"

The vehicle list only shows cars Tessie marks as active. Check the car is added
and active in the Tessie app.

### Commands are refused

Check that Tessie's virtual key is still paired with the car — the Tessie app
shows its status. ChargeHA re-reads the car's state after a refused command so
the dashboard shows what actually happened.
