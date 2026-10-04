# Mandaloun restaurant API

A small, dependency-free Node.js backend for the Mandaloun Westfield website. It provides restaurant information, menu storage, table request intake, private event enquiries, contact messages, newsletter consent records, and protected admin endpoints. Requests are stored in a local SQLite database.

## Run locally

Requires Node.js 22.5 or newer (Node 24 recommended). SQLite is provided by Node's built-in `node:sqlite` module; there are no packages to install.

```sh
cp .env.example .env
```

Set `ADMIN_API_KEY` to a secret of at least 32 characters. Generate one with `openssl rand -hex 32`. For local development, edit `.env` and run:

```sh
npm run dev
```

The API listens at `http://127.0.0.1:3000`. `DATABASE_PATH` defaults to `./data/mandaloun.sqlite`, and the data directory is created automatically. Set `CORS_ORIGINS` to the exact origin(s) serving the website, comma separated. Do not use `*` for a production site. The default bind address is loopback; set `HOST=0.0.0.0` only when the deployment needs external access.

## Endpoints

All request and response bodies are JSON. Errors use `{ "error": { "code", "message", "fields?" } }`. Customer submission endpoints are limited to 30 requests per source IP per minute. The body limit is 32 KB.

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/health` | Public | Process health check |
| GET | `/api/v1/restaurant` | Public | Contact details, address, hours and event capacity |
| GET | `/api/v1/menu` | Public | Active menu categories and available items |
| POST | `/api/v1/reservations` | Public | Create a table request; starts as `pending` |
| POST | `/api/v1/event-enquiries` | Public | Create a private dining, catering or bar enquiry |
| POST | `/api/v1/contact` | Public | Create a general contact message |
| POST | `/api/v1/newsletter` | Public | Subscribe after explicit consent |
| GET | `/api/v1/admin/{reservations,event-enquiries,contact-messages,newsletter,audit-log}` | Admin | List records; supports `limit` and `offset` |
| PATCH | `/api/v1/admin/{reservations,event-enquiries,contact-messages}/:id` | Admin | Update record status |
| GET | `/api/v1/admin/menu-categories` | Admin | List categories, including inactive |
| POST/PATCH/DELETE | `/api/v1/admin/menu-categories[/:id]` | Admin | Manage menu categories |
| GET | `/api/v1/admin/menu-items` | Admin | List all menu items |
| POST/PATCH/DELETE | `/api/v1/admin/menu-items[/:id]` | Admin | Manage menu items |

Admin calls require `Authorization: Bearer <ADMIN_API_KEY>`. Never put this key in browser code. Public menu data begins empty; add the site's current dishes through the admin API or a future import before switching the website to `/api/v1/menu`.

### Customer submissions

Table request example:

```sh
curl -X POST http://127.0.0.1:3000/api/v1/reservations \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: website-request-123' \
  -d '{"name":"Sam Example","email":"sam@example.com","phone":"+447700900000","date":"2026-10-18","time":"19:30","partySize":4,"occasion":"Birthday","notes":"One high chair, please"}'
```

The response means the request was received. It is **not a confirmed reservation**: the current backend does not know live table availability and does not connect to the restaurant's booking provider. Staff must review it and mark it confirmed or declined through the admin API. The `Idempotency-Key` header lets a frontend safely retry a submission without creating duplicate requests.

Event enquiry fields: `name`, `email`, `phone` (optional), `eventType`, `eventDate` (optional `YYYY-MM-DD`), `guestCount` (1–500), `service` (optional), `budget` (optional), and `notes` (optional). Contact uses `name`, `email`, `message`, with optional `phone` and `subject`. Newsletter uses `email` and `consent: true`; consent timestamp is stored for auditability.

### Admin examples

```sh
curl http://127.0.0.1:3000/api/v1/admin/reservations?limit=25 \
  -H "Authorization: Bearer $ADMIN_API_KEY"

curl -X PATCH http://127.0.0.1:3000/api/v1/admin/reservations/RESERVATION_ID \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' -d '{"status":"confirmed"}'

curl -X POST http://127.0.0.1:3000/api/v1/admin/menu-categories \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Lunch","description":"Monday to Friday","position":1}'

curl -X POST http://127.0.0.1:3000/api/v1/admin/menu-items \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"categoryId":"CATEGORY_ID","name":"Vegetarian Mezze Platter","description":"Tabbouleh, falafel, fatayer, houmous and vine leaves.","pricePence":1395,"dietaryTags":["vegetarian"],"allergens":["sesame"],"position":1}'
```

Prices are stored as integer pence where numeric pricing is available, avoiding floating point errors. `priceLabel` supports display formats that cannot be represented by one numeric price. Dietary and allergen arrays are stored per item; verify them with the kitchen before publishing them.

## Production notes

- Use HTTPS, a strong `ADMIN_API_KEY`, a managed persistent disk for the SQLite file, and backups of the database. SQLite is suitable for a single service instance with modest traffic; use a managed database before horizontal scaling.
- The in-memory IP rate limit is a basic abuse guard, not distributed rate limiting. Behind a proxy, configure trusted network controls at the proxy. Do not trust client-supplied forwarded IP headers.
- Booking requests, event enquiries and contact messages are saved but no email/SMS is sent. Add an authenticated mail provider or staff dashboard and delivery retries before relying on notifications.
- There is no real-time availability check, payment handling, customer account, or automated confirmation/cancellation message. Integrate the restaurant's booking/POS platform for those workflows.
- Newsletter signups store explicit consent, but no campaign is sent. Add unsubscribe handling and retention/deletion procedures before using this for marketing.
- Customer personal data is stored in SQLite. Restrict access to the server and backups, set a retention period, publish a privacy notice, and support data access/deletion requests under the restaurant's applicable privacy obligations.
- Admin edits to menu and status fields are recorded in `audit_log`; customer submission events do not contain sensitive payloads in that log.

## Data model

`menu_categories` → `menu_items`; `reservations`; `event_enquiries`; `contact_messages`; `newsletter_subscribers`; and `audit_log`. Schema is initialized automatically on startup. Back up the database with SQLite's online backup mechanism or while the service is safely stopped; avoid copying only the main `.sqlite` file while WAL writes are active.
