const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

/* ─── Keep-Alive HTTPS Agent for Performance ─────────────────── */
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 60000,
  keepAliveMsecs: 30000
});

/* ─── Configuration ──────────────────────────────────────────── */
const GOFILE_CONTENT_ID = 'a9V5tH';              // The default content hash from the URL
const API_SERVER       = 'api.gofile.io';
const PORT             = process.env.PORT || process.env.SERVER_PORT || 3001;
const DB_FILE          = path.join(__dirname, 'db.json');
const THUMBNAIL_DIR    = path.join(__dirname, 'thumbnails');
const CONFIG_FILE      = path.join(__dirname, 'config.json');
const RATINGS_FILE     = path.join(__dirname, 'ratings.json');

// Default config values (changed password to Iphone15prom@x hashed)
let config = {
  adminPasswordSalt: "dino_secure_salt_99",
  adminPasswordHash: "94aabe55cda673b5fa71c8cd7e656edd6b160bb2487e9083539d85d9b16efc5e"
};

// Load config securely from disk
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  }
} catch (err) {
  console.error('Error loading config.json:', err.message);
}

// Secure hash verification function (SHA-256 with Salt)
function verifyAdminPassword(password) {
  if (!password) return false;
  const hash = crypto.createHash('sha256').update(password + config.adminPasswordSalt).digest('hex');
  return hash === config.adminPasswordHash;
}

// Enforce thumbnail directory initialization
if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR);
}

/* ─── MongoDB Connection Configuration ────────────────────────── */
const mongoUri = process.env.MONGODB_URI;
let mongoClient = null;
let mongoDb = null;

if (mongoUri) {
  console.log('🔌 Connecting to MongoDB Atlas…');
  MongoClient.connect(mongoUri)
    .then(client => {
      mongoClient = client;
      mongoDb = client.db('dinotube');
      console.log('✅ Connected to MongoDB successfully!');
    })
    .catch(err => {
      console.error('❌ Failed to connect to MongoDB:', err.message);
    });
}

/* ─── Database Helpers ────────────────────────────────────────── */
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading db.json:', err.message);
  }
  return [];
}

function saveDB(videos) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(videos, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving db.json:', err.message);
  }
}

/* ─── Ratings Map Database Helpers ─── */
function loadRatings() {
  try {
    if (fs.existsSync(RATINGS_FILE)) {
      return JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading ratings.json:', err.message);
  }
  return {};
}

function saveRatings(ratings) {
  try {
    fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving ratings.json:', err.message);
  }
}

/* ─── IP-Locked View Session State ────────────────────────────── */
let recentViews = {}; // Map of `ip_videoId` -> timestamp

/* ─── Session State Map ───────────────────────────────────────── */
let sessions = {}; // Map of contentId -> session object

function getOrCreateSession(contentId) {
  if (!sessions[contentId]) {
    sessions[contentId] = {
      token:     null,
      wt:        null,
      videoUrl:  null,
      fileName:  null,
      ready:     false,
      refreshing: false
    };
  }
  return sessions[contentId];
}

/* ─── SHA-256 (pure JS, same as GoFile's wt.obf.js) ─────────── */
function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/* ─── Generate Website Token (reverse-engineered from wt.obf.js) */
function generateWT(token) {
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const browserLang = 'en-US';
  const timeSlot = Math.floor(Date.now() / 1000 / 14400).toString();
  const wtSecret = '9844d94d963d30';
  
  const raw = `${userAgent}::${browserLang}::${token}::${timeSlot}::${wtSecret}`;
  return sha256(raw);
}

/* ─── HTTPS request helper (returns parsed JSON) ─────────────── */
function httpsJSON(options, postData = null) {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      ...options,
      family: 4,
      agent: keepAliveAgent
    };
    const req = https.request(requestOptions, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { reject(new Error(`JSON parse error: ${body.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

/* ─── Step 1: Create a guest account ─────────────────────────── */
async function createGuestAccount() {
  console.log('👤 Creating guest account…');
  const { status, data } = await httpsJSON({
    hostname: API_SERVER,
    path: '/accounts',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });

  if (data.status !== 'ok') throw new Error(`Account creation failed: ${data.status}`);
  
  const token = data.data.token;
  console.log(`✅ Guest token: ${token.substring(0, 12)}…`);
  return token;
}

/* ─── Step 2: Fetch content metadata (get download link) ─────── */
async function fetchContentInfo(token, contentId) {
  console.log(`📂 Fetching content info for ${contentId}…`);
  
  const wt = generateWT(token);
  const params = new URLSearchParams({
    contentFilter: '',
    page: '1',
    pageSize: '1000',
    sortField: 'name',
    sortDirection: '1'
  });
  
  const { status, data } = await httpsJSON({
    hostname: API_SERVER,
    path: `/contents/${contentId}?${params.toString()}`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Website-Token': wt,
      'X-BL': 'en-US',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    }
  });
  
  if (data.status !== 'ok') throw new Error(`Content fetch failed: ${data.status}`);
  
  console.log(`✅ Content: "${data.data.name}" (${Object.keys(data.data.children || {}).length} children)`);
  return data.data;
}

/* ─── Step 3: Extract video download URL from content data ────── */
function extractVideoUrl(contentData) {
  const children = contentData.children || {};
  
  for (const [id, child] of Object.entries(children)) {
    if (child.type === 'file' && child.mimetype && child.mimetype.startsWith('video/')) {
      console.log(`🎬 Found video: "${child.name}" (${(child.size / 1024 / 1024).toFixed(1)} MB)`);
      console.log(`   Mimetype: ${child.mimetype}`);
      console.log(`   Link: ${child.link ? child.link.substring(0, 80) + '…' : 'N/A'}`);
      return { url: child.link, name: child.name, mime: child.mimetype };
    }
  }
  
  for (const [id, child] of Object.entries(children)) {
    if (child.type === 'file' && child.link) {
      console.log(`📄 Using first file: "${child.name}"`);
      return { url: child.link, name: child.name, mime: child.mimetype || 'video/mp4' };
    }
  }
  
  throw new Error('No downloadable file found in content');
}

/* ─── Initialize session for content ID ───────────────────────── */
async function initSession(contentId, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  console.log(`\n🌐 [Attempt ${attempt}/${MAX_ATTEMPTS}] Initializing session for ${contentId}…`);
  
  const sess = getOrCreateSession(contentId);
  
  try {
    const token = await createGuestAccount();
    const contentData = await fetchContentInfo(token, contentId);
    const video = extractVideoUrl(contentData);
    
    if (!video.url) throw new Error('No video URL found');
    
    sess.token    = token;
    sess.wt       = generateWT(token);
    sess.videoUrl  = video.url;
    sess.fileName  = video.name;
    sess.ready     = true;
    sess.refreshing = false;
    
    console.log(`✅ Session for ${contentId} ready!`);
    console.log(`   Video: ${video.url.substring(0, 80)}…\n`);
    return true;
    
  } catch (err) {
    console.error(`❌ Attempt ${attempt} failed for ${contentId}: ${err.message}`);
    
    if (attempt < MAX_ATTEMPTS) {
      const wait = attempt * 5;
      console.log(`⏳ Retrying in ${wait}s…`);
      await new Promise(r => setTimeout(r, wait * 1000));
      return initSession(contentId, attempt + 1);
    }
    
    sess.ready = false;
    sess.refreshing = false;
    return false;
  }
}

/* ─── Proxy the video stream ──────────────────────────────────── */
function proxyVideo(req, res) {
  const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
  const contentId = urlParams.get('c') || GOFILE_CONTENT_ID;
  
  const sess = getOrCreateSession(contentId);
  
  if (!sess.ready || !sess.videoUrl) {
    res.writeHead(503, { 
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end('Session not ready — initializing');
    
    if (!sess.refreshing) {
      sess.refreshing = true;
      initSession(contentId).then(ok => {
        sess.ready = ok;
        sess.refreshing = false;
      });
    }
    return;
  }
  
  const url = new URL(sess.videoUrl);
  
  const headers = {
    'Cookie':          `accountToken=${sess.token}`,
    'Referer':         `https://gofile.io/d/${contentId}`,
    'Origin':          'https://gofile.io',
    'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-fetch-dest':  'video',
    'sec-fetch-mode':  'no-cors',
    'sec-fetch-site':  'same-site',
    'sec-ch-ua':       '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"'
  };
  
  if (req.headers['range']) {
    headers['Range'] = req.headers['range'];
  }
  
  const proxyReq = https.request({
    hostname: url.hostname,
    path:     url.pathname + url.search,
    method:   req.method === 'HEAD' ? 'HEAD' : 'GET',
    family:   4,
    agent:    keepAliveAgent,
    headers
  }, proxyRes => {
    // Redirect handling
    if (proxyRes.statusCode === 302 || proxyRes.statusCode === 301) {
      const location = proxyRes.headers['location'];
      console.log(`⚠️  Redirect ${proxyRes.statusCode} → ${location || '(no location)'}`);
      
      if (!location || location.includes('gofile.io/d/') || location.includes('gofile.io/?')) {
        console.log(`🔄 Session expired for ${contentId} — refreshing…`);
        res.writeHead(503, { 
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end('Session expired — refreshing');
        
        if (!sess.refreshing) {
          sess.refreshing = true;
          sess.ready = false;
          initSession(contentId).then(ok => {
            sess.ready = ok;
            sess.refreshing = false;
          });
        }
        return;
      }
      
      const redirectUrl = new URL(location);
      const redirectReq = https.request({
        hostname: redirectUrl.hostname,
        path:     redirectUrl.pathname + redirectUrl.search,
        method:   req.method === 'HEAD' ? 'HEAD' : 'GET',
        family:   4,
        agent:    keepAliveAgent,
        headers:  { ...headers, Host: redirectUrl.hostname }
      }, redirectRes => {
        forwardResponse(redirectRes, res);
      });
      redirectReq.on('error', err => {
        console.error('[redirect error]', err.message);
        if (!res.headersSent) { 
          res.writeHead(502, { 
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }); 
          res.end('Redirect error'); 
        }
      });
      redirectReq.end();
      return;
    }
    
    // Auth issue handling
    if (proxyRes.statusCode === 403 || proxyRes.statusCode === 401) {
      console.log(`⚠️  Got ${proxyRes.statusCode} for ${contentId} — refreshing session…`);
      res.writeHead(503, { 
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end('Access denied — refreshing session');
      
      if (!sess.refreshing) {
        sess.refreshing = true;
        sess.ready = false;
        initSession(contentId).then(ok => {
          sess.ready = ok;
          sess.refreshing = false;
        });
      }
      return;
    }
    
    forwardResponse(proxyRes, res);
  });
  
  proxyReq.on('error', err => {
    if (err.code === 'ECONNRESET' || err.message.includes('abort')) {
      console.log(`[proxy info] Client aborted request for ${contentId}: ${err.message}`);
    } else {
      console.error('[proxy error]', err);
    }
    if (!res.headersSent) { 
      res.writeHead(502, { 
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }); 
      res.end('Proxy error'); 
    }
  });
  
  proxyReq.end();
}

function forwardResponse(upstream, clientRes) {
  const forward = {};
  ['content-type', 'content-length', 'content-range', 'accept-ranges',
   'last-modified', 'etag', 'cache-control'].forEach(h => {
    if (upstream.headers[h]) forward[h] = upstream.headers[h];
  });
  
  forward['Access-Control-Allow-Origin'] = '*';
  forward['Access-Control-Expose-Headers'] = 'Content-Range, Content-Length, Accept-Ranges';
  
  clientRes.writeHead(upstream.statusCode, forward);
  upstream.pipe(clientRes);
}

/* ─── Status endpoint ─────────────────────────────────────────── */
function handleStatus(req, res) {
  const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
  const contentId = urlParams.get('c') || GOFILE_CONTENT_ID;
  
  const sess = getOrCreateSession(contentId);
  const thumbPath = path.join(THUMBNAIL_DIR, `${contentId}.jpg`);
  const hasThumbnail = fs.existsSync(thumbPath);
  
  // Auto-trigger session initialization if not ready and not currently refreshing
  if (!sess.ready && !sess.refreshing) {
    sess.refreshing = true;
    console.log(`[status] Triggering background session initialization for ${contentId}`);
    initSession(contentId).then(ok => {
      sess.ready = ok;
      sess.refreshing = false;
    }).catch(err => {
      console.error(`[status error] Initialization failed for ${contentId}:`, err.message);
      sess.refreshing = false;
    });
  }
  
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({
    ready: sess.ready,
    refreshing: sess.refreshing,
    fileName: sess.fileName,
    hasToken: !!sess.token,
    hasVideoUrl: !!sess.videoUrl,
    hasThumbnail: hasThumbnail
  }));
}

/* ─── Collect POST Request Body ───────────────────────────────── */
function parseJSONBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

/* ─── Unified Data Controller ─────────────────────────────────── */
async function getVideos(sort = 'top') {
  if (mongoDb) {
    try {
      const cursor = mongoDb.collection('videos').find({}, { projection: { thumbnailBase64: 0 } });
      const videos = await cursor.toArray();
      const mapped = videos.map(v => ({ ...v, id: v._id }));
      if (sort === 'top') {
        mapped.sort((a, b) => b.views - a.views);
      } else {
        mapped.sort((a, b) => b.createdAt - a.createdAt);
      }
      return mapped;
    } catch (err) {
      console.error('Error fetching videos from MongoDB:', err.message);
    }
  }
  // Fallback to local file db
  const videos = loadDB();
  if (sort === 'top') {
    videos.sort((a, b) => b.views - a.views);
  } else {
    videos.sort((a, b) => b.createdAt - a.createdAt);
  }
  return videos;
}

/* ─── HTTP Server ─────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, X-Admin-Password');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ─── API: Serve Thumbnail Images (Tries DB first, then local filesystem) ───
  if (req.url.startsWith('/thumbnails/')) {
    const cleanPath = req.url.split('?')[0];
    const fileName = path.basename(cleanPath);
    const id = fileName.replace('.jpg', '');
    
    if (mongoDb) {
      try {
        const video = await mongoDb.collection('videos').findOne({ _id: id });
        if (video && video.thumbnailBase64) {
          const base64Data = video.thumbnailBase64.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64Data, 'base64');
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
          res.end(buffer);
          return;
        }
      } catch (err) {
        console.error('Error serving thumbnail from MongoDB:', err.message);
      }
    }
    
    // File fallback
    const filePath = path.join(THUMBNAIL_DIR, fileName);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(filePath).pipe(res);
      return;
    } else {
      res.writeHead(404);
      return res.end('Not found');
    }
  }

  // ─── API: Get Videos Listing ───
  if ((req.url === '/api/videos' || req.url.startsWith('/api/videos?')) && req.method === 'GET') {
    const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
    const sort = urlParams.get('sort') || 'top';
    const videosList = await getVideos(sort);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(videosList));
  }

  // ─── API: Admin Password Probe/Login (Dedicated Fast Endpoint) ───
  if (req.url === '/api/login' && req.method === 'POST') {
    const password = req.headers['x-admin-password'];
    if (verifyAdminPassword(password)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized: Invalid admin password' }));
    }
  }

  // ─── API: Add New Video (Secure Admin Endpoint) ───
  if (req.url === '/api/videos' && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      const password = req.headers['x-admin-password'];
      
      if (!verifyAdminPassword(password)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized: Invalid admin password' }));
      }
      
      const urlOrId = body.urlOrId || '';
      const trimmed = urlOrId.trim();
      const urlMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
      const contentId = (urlMatch && urlMatch[1]) ? urlMatch[1] : trimmed;
      
      if (!contentId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid link or ID' }));
      }
      
      const success = await initSession(contentId);
      if (!success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Failed to access GoFile video link. Please verify link is publicly accessible.' }));
      }
      
      const sess = getOrCreateSession(contentId);
      let targetVideo;
      
      if (mongoDb) {
        // MongoDB Upsert
        await mongoDb.collection('videos').updateOne(
          { _id: contentId },
          {
            $setOnInsert: {
              title: body.title || sess.fileName || 'GoFile Video',
              description: body.description || 'No description provided.',
              views: 0,
              rating: 0,
              ratingCount: 0,
              ratingSum: 0,
              reports: 0,
              duration: 0,
              createdAt: Date.now()
            }
          },
          { upsert: true }
        );
        const doc = await mongoDb.collection('videos').findOne({ _id: contentId });
        targetVideo = { ...doc, id: doc._id };
      } else {
        // File fallback
        const videos = loadDB();
        const existingIdx = videos.findIndex(v => v.id === contentId);
        
        if (existingIdx !== -1) {
          if (body.title) videos[existingIdx].title = body.title;
          if (body.description) videos[existingIdx].description = body.description;
          targetVideo = videos[existingIdx];
        } else {
          targetVideo = {
            id: contentId,
            title: body.title || sess.fileName || 'GoFile Video',
            description: body.description || 'No description provided.',
            views: 0,
            rating: 0,
            ratingCount: 0,
            ratingSum: 0,
            reports: 0,
            duration: 0,
            createdAt: Date.now()
          };
          videos.push(targetVideo);
        }
        saveDB(videos);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', data: targetVideo }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── API: Edit Video Metadata & Custom Thumbnail (Secure Admin Endpoint) ───
  if (req.url === '/api/videos/edit' && req.method === 'POST') {
    try {
      const password = req.headers['x-admin-password'];
      if (!verifyAdminPassword(password)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized: Invalid admin password' }));
      }
      
      const body = await parseJSONBody(req);
      const { id, title, description, thumbnail } = body;
      
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing video ID' }));
      }
      
      let updatedVideo;
      
      if (mongoDb) {
        const updateDoc = {};
        if (title !== undefined) updateDoc.title = title;
        if (description !== undefined) updateDoc.description = description;
        if (thumbnail) updateDoc.thumbnailBase64 = thumbnail;
        
        const result = await mongoDb.collection('videos').findOneAndUpdate(
          { _id: id },
          { $set: updateDoc },
          { returnDocument: 'after' }
        );
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Video not found' }));
        }
        updatedVideo = { ...result, id: result._id };
        console.log(`[admin] Updated video ${id} on MongoDB`);
      } else {
        const videos = loadDB();
        const idx = videos.findIndex(v => v.id === id);
        
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Video not found' }));
        }
        
        if (title !== undefined) videos[idx].title = title;
        if (description !== undefined) videos[idx].description = description;
        saveDB(videos);
        updatedVideo = videos[idx];
        
        if (thumbnail) {
          const base64Data = thumbnail.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64Data, 'base64');
          const thumbPath = path.join(THUMBNAIL_DIR, `${id}.jpg`);
          fs.writeFileSync(thumbPath, buffer);
          console.log(`[thumbnail] Custom thumbnail uploaded for video ${id}`);
        }
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', data: updatedVideo }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── API: Save/Update Video Duration ───
  if (req.url === '/api/videos/duration' && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      const { id, duration } = body;
      const val = parseFloat(duration);
      
      if (!id || isNaN(val) || val <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid ID or duration' }));
      }
      
      if (mongoDb) {
        await mongoDb.collection('videos').updateOne(
          { _id: id },
          { $set: { duration: val } }
        );
        console.log(`[duration] Updated duration for video ${id} to ${val}s in MongoDB`);
      } else {
        const videos = loadDB();
        const idx = videos.findIndex(v => v.id === id);
        if (idx !== -1) {
          videos[idx].duration = val;
          saveDB(videos);
          console.log(`[duration] Updated duration for video ${id} to ${val}s`);
        }
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── API: Submit Video Rating (IP-tied, overriding previous scores) ───
  if (req.url === '/api/videos/rate' && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      const { id, rating } = body;
      const val = parseInt(rating);
      
      if (!id || isNaN(val) || val < 1 || val > 5) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid ID or rating value' }));
      }
      
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const ratingKey = `${clientIp}_${id}`;
      let avgRating = 0;
      let ratingCount = 0;

      if (mongoDb) {
        await mongoDb.collection('ratings').updateOne(
          { _id: ratingKey },
          { $set: { score: val, videoId: id } },
          { upsert: true }
        );
        
        const ratingDocs = await mongoDb.collection('ratings').find({ videoId: id }).toArray();
        ratingCount = ratingDocs.length;
        const ratingSum = ratingDocs.reduce((sum, r) => sum + r.score, 0);
        avgRating = ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : 0;
        
        await mongoDb.collection('videos').updateOne(
          { _id: id },
          { $set: { ratingCount, ratingSum, rating: avgRating } }
        );
        console.log(`[ratings-db] Video ${id} average calculated to ${avgRating} (${ratingCount} reviews)`);
      } else {
        const ratings = loadRatings();
        ratings[ratingKey] = val;
        saveRatings(ratings);
        
        const videoRatings = Object.entries(ratings)
          .filter(([key]) => key.endsWith(`_${id}`))
          .map(([key, score]) => score);
        
        ratingCount = videoRatings.length;
        const ratingSum = videoRatings.reduce((sum, score) => sum + score, 0);
        avgRating = ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : 0;
        
        const videos = loadDB();
        const idx = videos.findIndex(v => v.id === id);
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Video not found' }));
        }
        
        videos[idx].ratingCount = ratingCount;
        videos[idx].ratingSum = ratingSum;
        videos[idx].rating = avgRating;
        saveDB(videos);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', rating: avgRating, ratingCount: ratingCount }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── API: Report Video Not Working ───
  if (req.url === '/api/videos/report' && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      const { id } = body;
      
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing video ID' }));
      }
      
      let updatedReports = 0;
      
      if (mongoDb) {
        const result = await mongoDb.collection('videos').findOneAndUpdate(
          { _id: id },
          { $inc: { reports: 1 } },
          { returnDocument: 'after' }
        );
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Video not found' }));
        }
        updatedReports = result.reports || 0;
      } else {
        const videos = loadDB();
        const idx = videos.findIndex(v => v.id === id);
        
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Video not found' }));
        }
        
        videos[idx].reports = (videos[idx].reports || 0) + 1;
        saveDB(videos);
        updatedReports = videos[idx].reports;
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', reports: updatedReports }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── API: Clear Reports (Secure Admin Endpoint) ───
  if (req.url === '/api/videos/reports/clear' && req.method === 'POST') {
    try {
      const password = req.headers['x-admin-password'];
      if (!verifyAdminPassword(password)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized: Invalid admin password' }));
      }
      
      const body = await parseJSONBody(req);
      const { id } = body;
      
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing video ID' }));
      }
      
      if (mongoDb) {
        await mongoDb.collection('videos').updateOne(
          { _id: id },
          { $set: { reports: 0 } }
        );
      } else {
        const videos = loadDB();
        const idx = videos.findIndex(v => v.id === id);
        
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Video not found' }));
        }
        
        videos[idx].reports = 0;
        saveDB(videos);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── API: Delete Video (Secure Admin Endpoint) ───
  if (req.url.startsWith('/api/videos') && req.method === 'DELETE') {
    try {
      const password = req.headers['x-admin-password'];
      if (!verifyAdminPassword(password)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized: Invalid admin password' }));
      }
      
      const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
      const id = urlParams.get('id');
      
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing video ID' }));
      }
      
      if (mongoDb) {
        await mongoDb.collection('videos').deleteOne({ _id: id });
        await mongoDb.collection('ratings').deleteMany({ videoId: id });
      } else {
        const videos = loadDB();
        const filtered = videos.filter(v => v.id !== id);
        
        if (videos.length === filtered.length) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Video not found' }));
        }
        
        saveDB(filtered);
        
        // Delete associated thumbnail file
        const thumbPath = path.join(THUMBNAIL_DIR, `${id}.jpg`);
        if (fs.existsSync(thumbPath)) {
          try { fs.unlinkSync(thumbPath); } catch {}
        }
        
        // Clean up ratings
        const ratings = loadRatings();
        let ratingsChanged = false;
        for (const ratingKey of Object.keys(ratings)) {
          if (ratingKey.endsWith(`_${id}`)) {
            delete ratings[ratingKey];
            ratingsChanged = true;
          }
        }
        if (ratingsChanged) {
          saveRatings(ratings);
        }
      }
      
      // Remove session cache
      delete sessions[id];
      console.log(`[admin] Video ${id} removed successfully`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', message: 'Video removed successfully' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── API: Upload Thumbnail (Secure Admin Endpoint) ───
  if (req.url === '/api/videos/thumbnail' && req.method === 'POST') {
    try {
      const password = req.headers['x-admin-password'];
      if (!verifyAdminPassword(password)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized: Invalid admin password' }));
      }
      
      const body = await parseJSONBody(req);
      const id = body.id;
      const image = body.image; // base64 string
      const duration = parseFloat(body.duration);
      
      if (!id || !image) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing video ID or image data' }));
      }
      
      if (mongoDb) {
        const setFields = { thumbnailBase64: image };
        if (!isNaN(duration) && duration > 0) setFields.duration = duration;
        await mongoDb.collection('videos').updateOne(
          { _id: id },
          { $set: setFields }
        );
      } else {
        const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const thumbPath = path.join(THUMBNAIL_DIR, `${id}.jpg`);
        fs.writeFileSync(thumbPath, buffer);
        
        if (!isNaN(duration) && duration > 0) {
          const videos = loadDB();
          const idx = videos.findIndex(v => v.id === id);
          if (idx !== -1) {
            videos[idx].duration = duration;
            saveDB(videos);
          }
        }
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', path: `/thumbnails/${id}.jpg` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── API: Auto Upload Thumbnail (Public auto-fetch, overwrite-protected) ───
  if (req.url === '/api/videos/thumbnail/auto' && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      const id = body.id;
      const image = body.image;
      const duration = parseFloat(body.duration);
      
      if (!id || !image) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing video ID or image data' }));
      }
      
      if (mongoDb) {
        const doc = await mongoDb.collection('videos').findOne({ _id: id });
        if (doc && doc.thumbnailBase64) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'exists', message: 'Thumbnail already exists' }));
        }
        
        const setFields = { thumbnailBase64: image };
        if (!isNaN(duration) && duration > 0) setFields.duration = duration;
        await mongoDb.collection('videos').updateOne(
          { _id: id },
          { $set: setFields }
        );
      } else {
        const thumbPath = path.join(THUMBNAIL_DIR, `${id}.jpg`);
        if (fs.existsSync(thumbPath)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'exists', message: 'Thumbnail already exists' }));
        }
        
        const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(thumbPath, buffer);
        
        if (!isNaN(duration) && duration > 0) {
          const videos = loadDB();
          const idx = videos.findIndex(v => v.id === id);
          if (idx !== -1) {
            videos[idx].duration = duration;
            saveDB(videos);
          }
        }
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', path: `/thumbnails/${id}.jpg` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ─── API: Increment View Count (IP-locked and session-protected) ───
  if (req.url === '/api/videos/view' && req.method === 'POST') {
    const body = await parseJSONBody(req);
    const id = body.id;
    if (id) {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const viewKey = `${clientIp}_${id}`;
      const now = Date.now();
      const lastView = recentViews[viewKey];
      
      let finalViews = 0;
      const isEligible = !lastView || (now - lastView > 3600000);
      
      if (mongoDb) {
        if (isEligible) {
          const doc = await mongoDb.collection('videos').findOneAndUpdate(
            { _id: id },
            { $inc: { views: 1 } },
            { returnDocument: 'after' }
          );
          finalViews = doc ? doc.views : 0;
          recentViews[viewKey] = now;
        } else {
          const doc = await mongoDb.collection('videos').findOne({ _id: id });
          finalViews = doc ? doc.views : 0;
        }
      } else {
        const videos = loadDB();
        const idx = videos.findIndex(v => v.id === id);
        if (idx !== -1) {
          if (isEligible) {
            videos[idx].views += 1;
            saveDB(videos);
            recentViews[viewKey] = now;
          }
          finalViews = videos[idx].views;
        }
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', views: finalViews }));
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Video not found' }));
  }
  
  if (req.url === '/video' || req.url.startsWith('/video?')) {
    return proxyVideo(req, res);
  }
  
  if (req.url === '/status' || req.url.startsWith('/status?')) {
    return handleStatus(req, res);
  }
  
  if (req.url === '/refresh' || req.url.startsWith('/refresh?')) {
    const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
    const contentId = urlParams.get('c') || GOFILE_CONTENT_ID;
    const sess = getOrCreateSession(contentId);
    
    if (!sess.refreshing) {
      sess.refreshing = true;
      sess.ready = false;
      initSession(contentId).then(ok => {
        sess.ready = ok;
        sess.refreshing = false;
      });
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('Refresh started');
  }
  
  // Serve SPA shell
  const file = path.join(__dirname, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

/* ─── Boot ────────────────────────────────────────────────────── */
(async () => {
  const defaultSess = getOrCreateSession(GOFILE_CONTENT_ID);
  defaultSess.ready = await initSession(GOFILE_CONTENT_ID);
  server.listen(PORT, () => {
    console.log(`🚀 Dinotube Server → http://localhost:${PORT}`);
    console.log(`   Video           → http://localhost:${PORT}/video`);
    console.log(`   Status          → http://localhost:${PORT}/status\n`);
  });
})();
