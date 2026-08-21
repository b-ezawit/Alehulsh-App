// Alehulsh (አለሁልሽ) - Interactive JavaScript Features

document.addEventListener('DOMContentLoaded', () => {
    
    // 1. Mobile Menu Drawer & Backdrop Toggle
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const closeDrawerBtn = document.getElementById('closeDrawerBtn');
    const mobileDrawer = document.getElementById('mobileDrawer');
    const drawerBackdrop = document.getElementById('drawerBackdrop');
    const drawerLinks = document.querySelectorAll('.drawer-link, .drawer-btn');

    function openDrawer() {
        if (mobileDrawer) mobileDrawer.classList.add('open');
        if (drawerBackdrop) drawerBackdrop.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeDrawer() {
        if (mobileDrawer) mobileDrawer.classList.remove('open');
        if (drawerBackdrop) drawerBackdrop.classList.remove('active');
        document.body.style.overflow = '';
    }

    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openDrawer();
        });
    }

    if (closeDrawerBtn) {
        closeDrawerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeDrawer();
        });
    }

    if (drawerBackdrop) {
        drawerBackdrop.addEventListener('click', closeDrawer);
    }

    drawerLinks.forEach(link => {
        link.addEventListener('click', closeDrawer);
    });

    // 2. FAQ Accordion Toggle
    const faqQuestions = document.querySelectorAll('.faq-question');

    faqQuestions.forEach(question => {
        question.addEventListener('click', () => {
            const item = question.parentElement;
            const isOpen = item.classList.contains('active');

            // Close all items
            document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('active'));

            // Toggle clicked item
            if (!isOpen) {
                item.classList.add('active');
            }
        });
    });

    // Open first FAQ by default
    const firstFaq = document.querySelector('.faq-item');
    if (firstFaq) {
        firstFaq.classList.add('active');
    }

    // 3. Navbar scroll effect
    const navbar = document.querySelector('.navbar');
    window.addEventListener('scroll', () => {
        if (window.scrollY > 30) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    });

});

// 4. Safety Modal SOS Simulation Functions
function openSafetyModal() {
    const modal = document.getElementById('safetyModal');
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeSafetyModal() {
    const modal = document.getElementById('safetyModal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// Close modal on click outside
window.addEventListener('click', (e) => {
    const modal = document.getElementById('safetyModal');
    if (e.target === modal) {
        closeSafetyModal();
    }
});

// iOS Coming Soon Modal / Alert
function showIosComingSoon(event) {
    if (event) event.preventDefault();
    alert("🍎 Alehulsh for iOS is currently in development!\n\nThe iOS version is being built and will be available soon on the Apple App Store.\n\nAndroid users can tap 'Download for Android' to get the live app APK now.");
}

// Android APK Download Feedback
document.addEventListener('DOMContentLoaded', () => {
    const androidBtn = document.getElementById('downloadAndroidBtn');
    if (androidBtn) {
        androidBtn.addEventListener('click', () => {
            console.log("Downloading Alehulsh Android APK (v1.0.1)...");
        });
    }
});
