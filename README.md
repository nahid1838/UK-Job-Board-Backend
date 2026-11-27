# UK Job Board API

For local development, copy [.env.example](.env.example) to `.env`, fill in `MONGODB_URI`, and run `npm install` followed by `npm run dev`. The default API address is http://localhost:5000.

## Deploy on Vercel

Import this Git repository as a separate project and select **Express**, with Node.js **24.x** and the default build and output settings. Keep **Automatically expose System Environment Variables** enabled so the app uses its serverless entry point. Set these variables in the project's **Production** environment.

| Backend variable | Production value |
| --- | --- |
| `MONGODB_URI` | The same MongoDB Atlas connection string as the frontend. Both apps use the `UkJobBoardDB` database. |
| `FRONTEND_ORIGIN` | The canonical HTTPS frontend origin. Use the same value as the frontend's `BETTER_AUTH_URL`. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Optional. Set both to enable application and employer workflow emails. |
| `SITE_CONTACT_EMAIL` | Optional default contact address for notifications. |

After deployment, check `/health` and `/api/categories` on the API hostname. Set the frontend project's `BACKEND_ORIGIN` to that hostname, without a path. The backend must be reachable by the frontend deployment, and the backend must be able to reach the frontend's `/api/auth/get-session` endpoint. If you use Vercel Deployment Protection, configure those server-to-server requests to be allowed.

An unauthenticated request to `/api/me` should return HTTP 401. Test authenticated access through `/board-api/me` on the frontend after signing in. When using a fresh database, bootstrap the first administrator from a trusted database console and add at least one visible job category before employers test publishing.
