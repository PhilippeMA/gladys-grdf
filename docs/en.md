# GRDF Gazpar

This integration reads the gas consumption measured by your **Gazpar** meter and
turns it into Gladys devices, so your gas shows up next to the rest of your home
data: daily charts, scenes, and the energy screen.

GRDF exposes no public API for individuals. The integration therefore signs in
to your customer account exactly like a browser would, on
[monespace.grdf.fr](https://monespace.grdf.fr), and reads the same daily
readings the website shows you.

## What you need

- a GRDF customer account (the one you use on monespace.grdf.fr), with your
  meter already attached to it;
- a **Gazpar** communicating meter — the daily readings only exist for those.
  With an older meter read twice a year by a technician, GRDF only publishes one
  lump reading per period, and that is all the integration can show;
- an account that does **not** ask for an extra verification step at login (a
  one-time code sent by SMS or email, a captcha). The integration can only answer
  the password step.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Enter the **email** and the **password** of your GRDF account. The password is
   stored encrypted by Gladys and is only ever sent to GRDF.
3. Leave **PCE to follow** empty to follow every meter of the account. If your
   account holds several metering points and you only want some of them, list
   their 14-digit PCE numbers, separated by commas. You will find a PCE on your
   gas bill, and in Mon Espace GRDF.
4. Choose the **history to import**: the number of past days fetched the first
   time the integration synchronizes. GRDF keeps about three years, so you can
   import several months at once if you want charts that already have a past.
   This only applies to the first synchronization; afterwards the integration
   only fetches what is new. Importing a long history takes a few minutes:
   Gladys accepts a limited number of measurements per minute, so the
   integration feeds them in gently — about one minute per two months imported.
5. Click **Test the GRDF connection**: it signs in and lists the metering points
   it found. This is the quickest way to check your credentials.
6. Save, then open the **Discovery** tab and **add your meter to your home**.
   This step is what starts the collection: until a meter is added, it is only
   an offer, and Gladys has nowhere to store its measurements. The history is
   imported the moment you add it.

## The devices you get

One device per metering point, named after the alias you gave it in Mon Espace,
carrying four read-only sensors:

| Sensor                         | Unit | What it is                                             |
| ------------------------------ | ---- | ------------------------------------------------------ |
| Consommation quotidienne       | kWh  | Energy consumed during the gas day — the billed value  |
| Volume quotidien               | m³   | Raw gas volume consumed during the gas day             |
| Index compteur                 | m³   | Meter index at the end of the gas day                  |
| Température extérieure moyenne | °C   | Average outside temperature GRDF associates to the day |

Every value is recorded with the date of the day it belongs to, not the date it
was downloaded: your charts stay correct even though the data arrives late.

## When the data arrives

GRDF publishes a reading **one to two days late**, usually during the day
following the measurement. There is nothing live here: the consumption of
Monday typically lands on Tuesday or Wednesday. This is a limit of the Gazpar
network itself (the meter transmits once a day), not of the integration.

The integration queries GRDF on its own schedule — every six hours by default,
which is far more than enough for a daily value. The **Refresh the data now**
action forces a fetch immediately if you do not want to wait.

## Troubleshooting

**"Test the GRDF connection" fails.** Try signing in on
[monespace.grdf.fr](https://monespace.grdf.fr) with the same credentials in a
private browser window. If GRDF asks you for a code or a captcha there, the
integration cannot get through either.

**The sensors exist but stay empty.** Check that the meter is really added to
your home, and not merely listed in the **Discovery** tab: Gladys only stores
measurements for devices you added. Once added, the history is imported within
seconds, and at worst within a minute — or use **Refresh the data now**. A long
history takes a few minutes to appear in full: it is fed in gently (see above),
oldest day first.

**"GRDF served its HTML app shell" or "the session was not accepted".** GRDF
answered with a web page instead of data. Their site does that when it does not
accept the session, and also when it is simply having a bad moment — it never
says which. The integration signs in again and retries a few times on its own;
if it still fails, wait a few minutes and use **Refresh the data now**. If it
lasts, check that monespace.grdf.fr works in your browser: GRDF sometimes throttles
an account that has signed in many times in a row.

**No new data for several days.** Check on the GRDF website that the readings
are actually published for your meter: a Gazpar meter that lost its radio link
stops feeding GRDF, and the integration can only show what GRDF has.

**The values look wrong or duplicated.** The integration remembers the last day
it published for each meter, so it never re-imports the same day twice. If you
delete a device and add it back, its history restarts from the import window you
configured.

For the full detail of what happens, look at the integration logs from the
Gladys interface (or `docker logs` on the host); set `LOG_LEVEL=debug` for the
verbose version.

## Privacy

Your GRDF credentials and your consumption data stay between your Gladys server
and GRDF. Nothing is sent anywhere else, and no third-party service is involved.
