# Cloudflare Configuration

This repository is configured to deploy to the Greenbro Cloudflare account and relies on a consistent set of edge resources across staging and production. The tables below summarise the bindings and identifiers that are now captured in `wrangler.toml`.

## Account

- **Account ID:** `0bee3514d14fef8558ccaf0bf2b72eb1`

## D1 Databases

| Environment | Binding | Database name         | Database ID                              |
|-------------|---------|-----------------------|------------------------------------------|
| Default / Production | `DB`    | `GREENBRO_DB`          | `4e2ddbf4-a12d-4a36-8e10-4a1a57f41d38` |
| Staging     | `DB`    | `GREENBRO_DB_STAGING` | `9ab01dd1-441c-452c-b439-55d9aa5938ab` |

## R2 Buckets

| Environment | Binding   | Bucket name        | Usage                     |
|-------------|-----------|--------------------|---------------------------|
| All envs    | `REPORTS` | `greenbro-reports` | Generated PDFs and exports |
| All envs    | `BRAND`   | `greenbro-brand`   | Brand assets               |
| All envs    | `ARCHIVE` | `greenbro-archive` | Cold telemetry archive     |

## KV Namespace

The worker binds the configuration namespace as `CONFIG`.

| Environment | Binding  | Namespace ID                           |
|-------------|----------|-----------------------------------------|
| Default / Production | `CONFIG` | `14ee885ce1ab45738c2619bd56a11361` |
| Staging     | `CONFIG` | `e9509ebd5bbb487e8e1698db35bfa439`      |

To work with the namespace inside the worker:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Write a key-value pair
    await env.CONFIG.put('KEY', 'VALUE');

    // Read a key-value pair
    const value = await env.CONFIG.get('KEY');

    // List existing keys
    const allKeys = await env.CONFIG.list();

    // Delete a key-value pair
    await env.CONFIG.delete('KEY');

    return new Response(JSON.stringify({ value, allKeys }));
  },
};
```

When running `wrangler dev`, set a `preview_id` if you need an isolated namespace for local development.

## Queues

| Environment | Binding    | Queue name | Purpose                            |
|-------------|------------|------------|------------------------------------|
| All envs    | `INGEST_Q` | `ingest-q` | Telemetry and heartbeat ingestion |

The worker both produces to and consumes from `ingest-q`, so the queue is declared in both the `[[queues.producers]]` and `[[queues.consumers]]` sections.

## Zero Trust Access

- **Team domain (issuer):** `bradleyayliffl.cloudflareaccess.com`
- **JWKS URL:** `https://bradleyayliffl.cloudflareaccess.com/cdn-cgi/access/certs`
- **Session duration:** 24 hours for both applications.

| Access application | Public hostname / pattern                                                     | AUD tag                                                              | Notes |
|--------------------|-------------------------------------------------------------------------------|----------------------------------------------------------------------|-------|
| `greenbro-heat-pump-app-2025 - Cloudflare Workers` | `*-greenbro-heat-pump-app-2025.bradleyayliffl.workers.dev`                  | `558e7450465163f7be473dcb75d5cea6d786f7143f3fcfe4dc658049c47c5e0b` | Primary API & dashboard worker (mirrors `ACCESS_AUD` binding). |
| `greeenbro-heat-pump-monitoring-2025 - Cloudflare Workers` | `*-greeenbro-heat-pump-monitoring-2025.bradleyayliffl.workers.dev` | `965324499988b497906c949af33be0c457edff0b9ac3edf8d287825b7d7af78d` | Wildcard access application for monitoring endpoints. |

Ensure the `ACCESS_AUD`, `ACCESS_ISS`, and `ACCESS_JWKS` bindings in `wrangler.toml` match these values before deploying. Rotate secrets (for example `JWT_SECRET`) with `wrangler secret put ...` as usual.
