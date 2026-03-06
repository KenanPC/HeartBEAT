import express from 'express';
import { createServer as createViteServer } from 'vite';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cookieParser());

// --- SPOTIFY OAUTH FLOW ---

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

async function getValidToken(req: express.Request, res: express.Response): Promise<string | null> {
  let token = req.cookies.spotify_access_token;
  if (token) return token;

  const refreshToken = req.cookies.spotify_refresh_token;
  if (!refreshToken) return null;

  try {
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });

    const data = await tokenResponse.json();
    if (data.error) {
      console.error('Failed to refresh token:', data.error);
      return null;
    }

    const cookieOptions = {
      secure: true,
      sameSite: 'none' as const,
      httpOnly: true,
      maxAge: data.expires_in * 1000
    };

    res.cookie('spotify_access_token', data.access_token, cookieOptions);
    if (data.refresh_token) {
      res.cookie('spotify_refresh_token', data.refresh_token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 });
    }

    return data.access_token;
  } catch (err) {
    console.error('Error refreshing token:', err);
    return null;
  }
}

app.get('/api/auth/url', (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Spotify credentials not configured in environment.' });
  }

  const redirectUri = req.query.redirect_uri as string;
  if (!redirectUri) {
    return res.status(400).json({ error: 'redirect_uri is required' });
  }

  const scopes = [
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-modify-playback-state',
    'user-read-playback-state',
    'streaming',
    'user-read-email',
    'user-read-private'
  ].join(' ');

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes,
    show_dialog: 'true',
    state: redirectUri // Pass the redirectUri in state so we can use it in the callback
  });

  res.json({ url: `https://accounts.spotify.com/authorize?${params.toString()}` });
});

app.get(['/auth/callback', '/auth/callback/'], async (req, res) => {
  const code = req.query.code as string;
  const error = req.query.error as string;
  const state = req.query.state as string;

  if (error) {
    return res.send(`<html><body><p>Error: ${error}</p></body></html>`);
  }

  if (!code) {
    return res.send(`<html><body><p>No code provided</p></body></html>`);
  }

  if (!state) {
    return res.send(`<html><body><p>No state provided (missing redirect_uri)</p></body></html>`);
  }

  try {
    const redirectUri = state;
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      })
    });

    const data = await tokenResponse.json();

    if (data.error) {
      throw new Error(data.error_description || data.error);
    }

    // Set cookies for iframe context
    const cookieOptions = {
      secure: true,
      sameSite: 'none' as const,
      httpOnly: true,
      maxAge: data.expires_in * 1000
    };

    res.cookie('spotify_access_token', data.access_token, cookieOptions);
    if (data.refresh_token) {
      res.cookie('spotify_refresh_token', data.refresh_token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 }); // 30 days
    }

    // Close the popup and notify parent
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (err: any) {
    console.error('Spotify token exchange error:', err);
    res.send(`<html><body><p>Failed to exchange token: ${err.message}</p></body></html>`);
  }
});

// --- SPOTIFY API PROXY ROUTES ---

app.get('/api/spotify/token', async (req, res) => {
  const token = await getValidToken(req, res);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ token });
});

app.get('/api/spotify/me', async (req, res) => {
  const token = await getValidToken(req, res);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const response = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    if (response.ok) {
      res.json(data);
    } else {
      res.status(response.status).json(data);
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

app.get('/api/spotify/playlists', async (req, res) => {
  const token = await getValidToken(req, res);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const response = await fetch('https://api.spotify.com/v1/me/playlists?limit=50', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    if (response.ok) {
      res.json(data);
    } else {
      res.status(response.status).json(data);
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

app.put('/api/spotify/play', async (req, res) => {
  const token = await getValidToken(req, res);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { context_uri, device_id } = req.body;
  let url = 'https://api.spotify.com/v1/me/player/play';
  if (device_id) url += `?device_id=${device_id}`;

  const fetchOptions: any = {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`
    }
  };

  if (context_uri) {
    fetchOptions.headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify({ context_uri });
  }

  try {
    const response = await fetch(url, fetchOptions);

    if (response.status === 404) {
      return res.status(404).json({ error: 'No active device found. Please open Spotify on a device.' });
    }
    
    if (response.status === 403) {
      return res.status(403).json({ error: 'Premium required or action not allowed.' });
    }

    if (response.ok || response.status === 204) {
      res.json({ success: true });
    } else {
      const data = await response.json();
      res.status(response.status).json(data);
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to play' });
  }
});

app.put('/api/spotify/pause', async (req, res) => {
  const token = await getValidToken(req, res);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { device_id } = req.body;
  let url = 'https://api.spotify.com/v1/me/player/pause';
  if (device_id) url += `?device_id=${device_id}`;

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (response.status === 404) {
      return res.status(404).json({ error: 'No active device found.' });
    }

    if (response.ok || response.status === 204) {
      res.json({ success: true });
    } else {
      const data = await response.json();
      res.status(response.status).json(data);
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to pause' });
  }
});

app.put('/api/spotify/transfer', async (req, res) => {
  const token = await getValidToken(req, res);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { device_id } = req.body;

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ device_ids: [device_id], play: false })
    });

    if (response.ok || response.status === 204) {
      res.json({ success: true });
    } else {
      const data = await response.json();
      res.status(response.status).json(data);
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to transfer playback' });
  }
});

app.get('/api/spotify/logout', (req, res) => {
  res.clearCookie('spotify_access_token', { secure: true, sameSite: 'none' });
  res.clearCookie('spotify_refresh_token', { secure: true, sameSite: 'none' });
  res.json({ success: true });
});

// --- VITE MIDDLEWARE ---

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
