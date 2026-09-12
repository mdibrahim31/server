require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

// Supabase Configuration from Environment Variables
const SUPABASE_URL = process.env.SUPABASE_URL;
// Prefer SERVICE_ROLE_KEY for admin auto bucket/table creation, fallback to SUPABASE_KEY / ANON_KEY
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const BUCKET_NAME = process.env.SUPABASE_BUCKET || 'images';
const TABLE_NAME = process.env.SUPABASE_TABLE || 'images';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('⚠️ WARNING: SUPABASE_URL and SUPABASE_KEY environment variables are required!');
}

const supabase = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_KEY || 'placeholder');

// Middleware
app.use(cors({
  origin: '*', // In production, specify your Customer and Vendor domain URLs
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Memory storage for Multer file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (JPEG, PNG, WebP, GIF, SVG) are allowed!'));
    }
  }
});

// ==========================================
// 1. AUTO INITIALIZATION (Bucket & Schema)
// ==========================================
async function initSupabaseStorage() {
  try {
    console.log(`🔍 Checking Supabase storage bucket "${BUCKET_NAME}"...`);
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    
    if (listError) {
      console.error('⚠️ Could not list buckets:', listError.message);
      return;
    }

    const bucketExists = buckets && buckets.some(b => b.name === BUCKET_NAME);
    if (!bucketExists) {
      console.log(`✨ Bucket "${BUCKET_NAME}" not found. Creating public bucket...`);
      const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
        public: true,
        fileSizeLimit: 15728640, // 15MB
        allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']
      });

      if (createError) {
        console.error('⚠️ Error creating bucket:', createError.message);
      } else {
        console.log(`✅ Storage bucket "${BUCKET_NAME}" successfully created and made PUBLIC!`);
      }
    } else {
      console.log(`✅ Storage bucket "${BUCKET_NAME}" is ready.`);
    }
  } catch (err) {
    console.error('Initialization error:', err.message);
  }
}

// Call on startup
initSupabaseStorage();

// ==========================================
// 2. HEALTH CHECK & STATUS API
// ==========================================
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Supabase 3-Tier Image Hub Backend is running!',
    endpoints: {
      health: 'GET /api/health',
      images: 'GET /api/images',
      search: 'GET /api/images/search?q=keyword',
      upload: 'POST /api/upload (multipart/form-data)'
    }
  });
});

app.get('/api/health', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from(TABLE_NAME)
      .select('*', { count: 'exact', head: true });

    res.json({
      status: 'ok',
      supabaseConnected: !error,
      bucket: BUCKET_NAME,
      table: TABLE_NAME,
      totalImagesInDb: count || 0,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==========================================
// 3. VENDOR API: UPLOAD IMAGE
// ==========================================
// Uploads file to Supabase Storage Bucket -> Gets Public URL -> Inserts record into Database Table
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file uploaded.' });
    }

    const {
      title,
      description = '',
      category = 'General',
      tags = '',
      vendor_name = 'Anonymous Vendor',
      price = 0
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Title is required for the image.' });
    }

    // Process tags (comma separated or JSON array)
    let parsedTags = [];
    if (Array.isArray(tags)) {
      parsedTags = tags;
    } else if (typeof tags === 'string' && tags.trim()) {
      parsedTags = tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    }

    // Generate safe, unique filename
    const fileExt = req.file.originalname.split('.').pop();
    const sanitizedBase = req.file.originalname
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .toLowerCase();
    const uniqueFileName = `${Date.now()}_${sanitizedBase}.${fileExt}`;
    const storagePath = `uploads/${uniqueFileName}`;

    console.log(`📤 Uploading "${uniqueFileName}" to Supabase bucket "${BUCKET_NAME}"...`);

    // A) Upload to Supabase Storage Bucket
    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      console.error('Supabase Storage error:', uploadError);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload image to Supabase Storage: ' + uploadError.message
      });
    }

    // B) Get Public Accessible URL
    const { data: publicUrlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(storagePath);

    const publicUrl = publicUrlData.publicUrl;
    console.log('🔗 Public URL generated:', publicUrl);

    // C) Store image metadata + URL into Supabase Database Table
    const newRecord = {
      title: title.trim(),
      description: description.trim(),
      image_url: publicUrl,
      file_name: req.file.originalname,
      file_size: req.file.size,
      mime_type: req.file.mimetype,
      category: category.trim(),
      tags: parsedTags,
      vendor_name: vendor_name.trim(),
      price: parseFloat(price) || 0,
      created_at: new Date().toISOString()
    };

    const { data: dbData, error: dbError } = await supabase
      .from(TABLE_NAME)
      .insert([newRecord])
      .select()
      .single();

    if (dbError) {
      console.error('Supabase DB Insert error:', dbError);
      return res.status(500).json({
        success: false,
        message: 'Image uploaded to storage but failed to save in database: ' + dbError.message,
        image_url: publicUrl
      });
    }

    console.log('✅ Image record saved successfully with ID:', dbData.id);

    return res.status(201).json({
      success: true,
      message: 'Image uploaded and stored in Supabase successfully!',
      data: dbData
    });
  } catch (error) {
    console.error('Server error during upload:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 4. CUSTOMER API: GET & SEARCH IMAGES
// ==========================================
// Supports text search, category filtering, tag filtering, and sorting
app.get('/api/images', async (req, res) => {
  try {
    const { q, category, tag, limit = 50, sort = 'desc' } = req.query;

    let query = supabase
      .from(TABLE_NAME)
      .select('*')
      .order('created_at', { ascending: sort === 'asc' })
      .limit(parseInt(limit));

    // Category filter
    if (category && category !== 'All') {
      query = query.eq('category', category);
    }

    // Specific tag filter
    if (tag) {
      query = query.contains('tags', [tag.toLowerCase()]);
    }

    // Full text search across title, description, vendor_name
    if (q && q.trim()) {
      const searchTerm = q.trim();
      query = query.or(`title.ilike.%${searchTerm}%,description.ilike.%${searchTerm}%,vendor_name.ilike.%${searchTerm}%`);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    res.json({
      success: true,
      count: data ? data.length : 0,
      data: data || []
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Search endpoint alias
app.get('/api/images/search', async (req, res) => {
  try {
    const { q = '', category = 'All' } = req.query;
    let query = supabase.from(TABLE_NAME).select('*').order('created_at', { ascending: false });

    if (category !== 'All') {
      query = query.eq('category', category);
    }

    if (q) {
      query = query.or(`title.ilike.%${q}%,description.ilike.%${q}%,vendor_name.ilike.%${q}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete image endpoint
app.delete('/api/images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from(TABLE_NAME).delete().eq('id', id);

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    res.json({ success: true, message: 'Image record deleted successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Start Express Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📦 Supabase Target: ${SUPABASE_URL || 'Not configured'}`);
});
