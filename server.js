require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Supabase Connection Client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Multer Config (Memory Storage-এ ছবি রিসিভ করার জন্য)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });


// -------------------------------------------------------------
// Route 1: Vendor - প্রোডাক্টের তথ্য ও ইমেজ আপলোড করার API
// -------------------------------------------------------------
app.post('/api/upload-product', upload.single('image'), async (req, res) => {
    try {
        const { title, price } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'Please upload an image file.' });
        }

        // ১. ফাইলের জন্য একটি ইউনিক নাম তৈরি
        const fileName = `${Date.now()}_${file.originalname}`;

        // ২. Supabase Storage-এর 'product-images' বাক্যাটে ইমেজ আপলোড
        const { data: storageData, error: storageError } = await supabase.storage
            .from('product-images')
            .upload(fileName, file.buffer, {
                contentType: file.mimetype
            });

        if (storageError) throw storageError;

        // ৩. আপলোড হওয়া ইমেজের Public Web URL সংগ্রহ
        const { data: publicUrlData } = supabase.storage
            .from('product-images')
            .getPublicUrl(fileName);

        const imageUrl = publicUrlData.publicUrl;

        // ৪. Supabase Database-এর 'products' টেবিলে Product Info + Image URL সেভ করা
        const { data: dbData, error: dbError } = await supabase
            .from('products')
            .insert([
                { 
                    title: title, 
                    price: parseFloat(price), 
                    image_url: imageUrl 
                }
            ]);

        if (dbError) throw dbError;

        res.status(200).json({
            success: true,
            message: 'Product & image uploaded and saved successfully!',
            imageUrl: imageUrl
        });

    } catch (error) {
        console.error('Upload Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// -------------------------------------------------------------
// Route 2: Customer - ডাটাবেস থেকে সব প্রোডাক্ট আনার API
// -------------------------------------------------------------
app.get('/api/products', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.status(200).json({
            success: true,
            products: data
        });
    } catch (error) {
        console.error('Fetch Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// Server Start
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Backend Server is running on port ${PORT}`);
});

