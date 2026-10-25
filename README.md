# FalconOath

An offline app for BA, BF, FG and FG X Falcons, on the laptop and the phone.
Step 1 is fault code lookup (DTC). See PLAN.md for what comes next.

## First run (laptop)

    cd falcon-app
    python -X utf8 -m falconoath setup        # builds data/falcon.db and the data copy
    tailscale serve --bg --https=8443 8767    # once; leaves VPA's 443 alone
    FalconOath.bat                            # listener + opens http://localhost:8767

## Pair a phone or browser

    python -X utf8 -m falconoath pair

In the app, go to Settings, then Pair, and type the code. On the phone, open
`https://<laptop>.<tailnet>.ts.net:8443` with Tailscale on, pair, then use
Firefox's ⋮ menu → Add app to Home screen.

## Tests

    python -X utf8 -m tests.run_all
