# Post-migration seeding

Freshly applied migrations leave several operational settings empty. Run the seeding helper immediately after `wrangler d1 migrations apply` so Slack alerts, commissioning thresholds, SLO contacts, and Access bindings are hydrated before any traffic lands on the worker.

## Usage

1. Create a config file (for example `ops-seed.json`):

   ```json
   {
     "opsWebhookUrl": "https://hooks.slack.com/services/T000/B000/XXXX",
     "commissioning": {
       "deltaTMin": 5,
       "flowMinLpm": 6,
       "copMin": 2.5,
       "reportRecipients": [
         "qa@greenbro.example",
         "ops@greenbro.example"
       ]
     },
     "sloContacts": [
       {
         "clientId": "demo-client",
         "uptimeTarget": 0.995,
         "ingestTarget": 0.99,
         "copTarget": 2.8,
         "reportRecipients": [
           "alice@customer.example",
           "bob@customer.example"
         ]
       }
     ],
     "accessBindings": [
       {
         "subject": "ops-team@example.com",
         "roles": ["ops"],
         "clientIds": ["demo-client"]
       }
     ]
   }
   ```

2. Apply the seed in the same directory as `wrangler.toml`:

   ```bash
   npm run seed:ops -- --database GREENBRO_DB --config ops-seed.json
   ```

   Override individual values on the CLI if you prefer not to create a config file:

   ```bash
   npm run seed:ops -- --database GREENBRO_DB \
     --ops-webhook https://hooks.slack.com/services/T000/B000/XXXX \
     --commissioning-delta-t 5 --commissioning-flow 6 --commissioning-cop 2.5 \
     --commissioning-report qa@greenbro.example,ops@greenbro.example
   ```

The script generates `INSERT ... ON CONFLICT` statements so it is safe to re-run whenever thresholds change. When Access group membership shifts, update the `accessBindings` block and re-run the helper to keep the worker-auth mapping consistent.
