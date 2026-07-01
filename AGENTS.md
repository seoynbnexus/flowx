<!-- BEGIN:meta-oauth-setup -->
# Meta Developer App Setup Guide

## Prerequisites
- A Facebook account (personal)
- An Instagram Business or Creator account linked to a Facebook Page

## Step 1: Create a Meta App
1. Go to https://developers.facebook.com/
2. Click **My Apps** → **Create App**
3. Select **Business** as the app type
4. Enter app name: `FlowX` (or your brand)
5. Add your email and click **Create App**

## Step 2: Add Products
In the app dashboard, add these products:

1. **Facebook Login**
   - Click **Set Up** → select **Web**
   - In **Settings** → **Valid OAuth Redirect URIs**, add:
     `https://yourdomain.com/api/v1/publisher/accounts/oauth/callback`
   - For local dev: `http://localhost:3001/api/v1/publisher/accounts/oauth/callback`

2. **Instagram Graph API**
   - Click **Set Up** — this enables access to Business/Creator Instagram accounts

## Step 3: Note App Credentials
- **App ID** → copy to `.env` as `META_APP_ID`
- **App Secret** (in Settings → Basic) → copy to `.env` as `META_APP_SECRET`

## Step 4: Configure `.env`
```
META_APP_ID=your_app_id
META_APP_SECRET=your_app_secret
META_REDIRECT_URI=http://localhost:3001/api/v1/publisher/accounts/oauth/callback
```

## Step 5: Add Test Users (for development)
1. Go to **App Roles** → **Test Users**
2. Click **Add** → create a test user
3. The test user has a Facebook account you can use to log in
4. Convert the test user's Instagram to Business: Settings → Account → Switch to Professional → Business
5. Link it to the test user's Facebook Page

## Step 6: Permissions (Development Mode)
The following permissions are granted by default in development mode:
- `instagram_basic` — read profile and media
- `pages_show_list` — list Facebook Pages
- `pages_read_engagement` — read page data

Additional permissions for future posting/analytics features:
- `instagram_content_publish` — publish content (needs app review for production)
- `instagram_manage_insights` — read insights (needs app review)
- `pages_manage_posts` — manage page posts (needs app review)

## Step 7: Moving to Production
When ready for production:
1. Complete **App Review** for each permission
2. Submit your app for **App Review** → **Requests**
3. Once approved, switch the app from **Development** to **Live** mode
4. Ensure `META_REDIRECT_URI` points to your production domain

## Troubleshooting
- **"No Instagram Business account found"**: Ensure the Instagram account is set to Business/Creator and linked to a Facebook Page
- **"Invalid redirect URI"**: Double-check the exact URL in Meta App settings
- **Token refresh fails**: The long-lived token lasts 60 days; user needs to reconnect after expiry
- **Graph API errors**: Check which version you're using (`v22.0` is current). Some fields may differ between versions

## Graph API Version
Current version: `v22.0`. Update `GRAPH_VERSION` in `shared/services/meta-oauth.config.js` if needed.
<!-- END:meta-oauth-setup -->
