


## Google / Facebook login setup

Social login is built into the client authentication flow. Add these environment variables to the backend deployment:

```env
BACKEND_PUBLIC_URL=https://YOUR-BACKEND-DOMAIN
OAUTH_FRONTEND_URL=https://YOUR-FRONTEND-DOMAIN

GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=https://alphaedge-backend-loxi.onrender.com/api/auth/google/callback

FACEBOOK_APP_ID=your_facebook_app_id
FACEBOOK_APP_SECRET=your_facebook_app_secret
FACEBOOK_REDIRECT_URI=https://alphaedge-backend-loxi.onrender.com/api/auth/facebook/callback
```

The Google and Facebook developer consoles must use the exact callback URLs above. If the provider credentials are not configured, the normal mobile/email + password registration and login continue to work.

### New stock-access flow

The dashboard is public. Opening any company/stock detail while logged out opens **Register first**. After registration, the user is taken to **Login**. After successful login, the originally selected stock opens automatically. Google/Facebook OAuth follows the same stock continuation flow.


## WhatsApp / Truecaller login setup

WhatsApp login uses a real Meta WhatsApp Cloud API OTP flow. Configure these on the backend: 

```env
WHATSAPP_ACCESS_TOKEN=your_meta_whatsapp_access_token
WHATSAPP_PHONE_NUMBER_ID=your_whatsapp_phone_number_id
WHATSAPP_OTP_TEMPLATE_NAME=your_approved_otp_template_name
WHATSAPP_OTP_LANGUAGE=en_US
WHATSAPP_GRAPH_VERSION=v24.0

TRUECALLER_CLIENT_ID=your_truecaller_client_id
TRUECALLER_CLIENT_SECRET=your_truecaller_client_secret
TRUECALLER_AUTHORIZE_URL=your_truecaller_authorize_url
TRUECALLER_TOKEN_URL=your_truecaller_token_url
TRUECALLER_PROFILE_URL=your_truecaller_profile_url
TRUECALLER_REDIRECT_URI=https://alphaedge-backend-loxi.onrender.com/api/auth/truecaller/callback
TRUECALLER_SCOPE=profile
```

Callback URLs for the current backend:
- Google: `https://alphaedge-backend-loxi.onrender.com/api/auth/google/callback`
- Facebook: `https://alphaedge-backend-loxi.onrender.com/api/auth/facebook/callback`
- Truecaller: `https://alphaedge-backend-loxi.onrender.com/api/auth/truecaller/callback`

WhatsApp does not use an OAuth callback; it sends a one-time password through the configured WhatsApp template.

## Social login session handoff
The frontend stores the short-lived signed social `authToken` returned after Google/Facebook/Truecaller authentication and sends it to the backend as a Bearer token. This avoids relying solely on cross-site cookies between the separate Render frontend and backend services.
