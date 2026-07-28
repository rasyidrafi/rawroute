# RawRoute

RawRoute is a small, protocol-preserving AI provider gateway. It aggregates user-configured providers and exposes prefixed model IDs without translating between API formats.

RawRoute changes only the request's `model` value, injects upstream authentication and configured headers, then streams the upstream response back without parsing or rebuilding it.

## Native endpoints

| Protocol | Endpoint |
| --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses` |
| Anthropic Messages | `POST /v1/messages` |
| Model catalog | `GET /v1/models` |

A request sent to the wrong protocol endpoint is rejected. RawRoute never attempts format conversion.

## Development

Requirements: Bun 1.3 or newer and access to Firestore or the Firestore emulator.

```bash
bun install
cp .env.example .env.local
bun dev
```

The initial credentials are:

- Username: `admin`
- Password: `change-me-now`
- Gateway key: `sk-local-change-me`

The dashboard forces the admin password to be changed after the first login. Override all bootstrap credentials in production using environment variables backed by Secret Manager.

Production initialization refuses to create Firestore state when the documented defaults are used or when `SESSION_SECRET` is shorter than 32 characters.

Run checks with:

```bash
bun test
bun run lint
bun run build
```

For explicit service-account authentication, set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY`. Newlines in the private key may be encoded as `\n`. When these variables are absent, Cloud Run uses Application Default Credentials from the assigned service identity.

## Docker

The image contains the Next.js dashboard, backend, and streaming proxy:

```bash
docker build -t rawroute .
docker run --rm -p 8080:8080 --env-file .env.local rawroute
```

## Cloud Run

Create the Firestore database first, then deploy the single image with these settings:

```bash
gcloud run deploy rawroute \
  --source . \
  --region YOUR_REGION \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,FIRESTORE_DATABASE_ID=ai-proxy,FIRESTORE_COLLECTION_PREFIX=rawroute \
  --set-secrets DEFAULT_ADMIN_PASSWORD=rawroute-admin-password:latest,DEFAULT_PROXY_API_KEY=rawroute-proxy-key:latest,SESSION_SECRET=rawroute-session-secret:latest
```

Grant the Cloud Run service account Firestore access. `roles/datastore.user` is the usual starting point; use a narrower custom role when practical. The proxy caches its routing snapshot in each instance for `ROUTING_CACHE_TTL_MS` (10 seconds by default), avoiding a Firestore read for every inference request.

Proxy request bodies are limited by `MAX_PROXY_BODY_BYTES` (10 MiB by default), including streamed requests without a `Content-Length` header.

Do not mount SQLite or JSON state on a Cloud Storage bucket. Firestore is the persistent configuration source and supports multiple Cloud Run instances safely.

## Provider secrets

Provider credentials entered in the dashboard are stored in Firestore and are never returned to the browser after saving. Firestore encrypts stored data at rest, but access is controlled by the Cloud Run service identity, so keep its IAM permissions narrow. A future Secret Manager-backed credential adapter can remove these values from the configuration document entirely.

## Documentation sources

- [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting)
- [Next.js Route Handler streaming](https://nextjs.org/docs/app/guides/streaming)
- [shadcn Next.js installation](https://ui.shadcn.com/docs/installation/next)
- [shadcn blocks](https://ui.shadcn.com/blocks)
- [Firebase Admin server setup](https://firebase.google.com/docs/admin/setup)
- [Cloud Run service identity](https://cloud.google.com/run/docs/securing/service-identity)
- [Cloud Run secrets](https://cloud.google.com/run/docs/configuring/services/secrets)
