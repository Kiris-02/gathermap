/**
 * GatherMap Reactive State Factory
 * Manages the application baseline state, session URL param resolution, and voter persistence.
 */
window.createInitialState = function() {
    // 1. Resolve Outing ID from URL or default
    const urlParams = new URLSearchParams(window.location.search);
    const urlOutingCode = urlParams.get('outing');
    const urlShareToken = urlParams.get('token');
    if (urlShareToken) {
        window._currentShareToken = urlShareToken;
    }
    
    // 2. Resolve or generate persistent Voter ID & Name
    let voterId = '';
    try {
        voterId = localStorage.getItem('gathermap_voter_id');
        if (!voterId) {
            voterId = 'voter_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
            localStorage.setItem('gathermap_voter_id', voterId);
        }
    } catch (_) {
        voterId = 'voter_' + Math.random().toString(36).substring(2, 9);
    }

    let voterName = 'You';
    try {
        voterName = localStorage.getItem('gathermap_voter_name') || 'You';
    } catch (_) {}

    return {
        // Session / Outing identifiers
        outingCode: urlOutingCode || '',
        shareToken: urlShareToken || '',
        sessionLoaded: false,
        voterId: voterId,
        voterName: voterName,
        copied: false,

        // Filter & View State
        searchRadiusMeters: 3000,
        activeScenario: 'all',
        activeQuickFilter: 'all',
        mobileView: 'list', // 'list' | 'map'
        
        // Progress Flags
        ranking: false,
        parsing: false,
        locating: false,
        searchingCenter: false,
        votedVenueId: null,
        votesMap: {},
        votesList: [],
        emptyStateReason: null, // null | 'no_data' | 'filter_empty' | 'hard_constraint_filtered' | 'api_error'
        searchFailed: false,
        isShortlistStale: false,
        searchErrorMessage: '',

        // Modals & Panels
        showGroupModal: false,
        showReviewersModal: false,
        showShareModal: false,

        // Map & Coordinates
        isCustomCenter: false,
        customCenterAddress: '',
        lastResolvedCenterAddress: '',
        centerCoords: { lat: 10.7782, lng: 106.6912 }, // Ho Chi Minh City Center
        mapTileError: false,

        // Group Members
        friends: [
            { id: 1, name: 'You', lat: 10.7798, lng: 106.6990, color: 'bg-blue-500', wish: '', customAddress: '' },
            { id: 2, name: 'Bob', lat: 10.7950, lng: 106.7218, color: 'bg-emerald-500', wish: '', customAddress: '' },
            { id: 3, name: 'Charlie', lat: 10.7827, lng: 106.6958, color: 'bg-indigo-500', wish: '', customAddress: '' }
        ],

        // Natural Language Discussion & Constraints
        discussionText: '',
        confirmedConstraints: {
            vegetarian: false,
            no_alcohol: false,
            quiet_only: false,
            max_price_vnd: null
        },
        confirmedSoftPreferences: [],
        parsedInterpretation: {
            hardConstraints: {},
            cuisines: [],
            dishes: [],
            ambience: [],
            features: [],
            negativePreferences: [],
            rawIntent: ''
        },

        // Search Results & Selection
        searchRequestId: 0,
        searchAbortController: null,
        shortlist: [],
        nearbyAlternatives: [],
        selectedVenue: null,
        searchMessage: '',

        // Reviewers Drawer & Submissions
        activeReviewerVenue: null,
        drawerNewReview: {
            content: '',
            rating: 5
        },

        // Share Dialog Data
        shareModalData: {
            message: '',
            shareUrl: '',
            venueName: '',
            appUrl: ''
        },

        // Presets & Backend Capability
        presetsList: [],
        activePresetId: null,
        backendConfig: {
            aiModel: 'Gemini Flash',
            databaseType: 'SQLite Persistent',
            isSupabaseConfigured: false
        },

        // Notifications
        toastMessage: '',
        toastType: 'info', // 'info' | 'success' | 'warning' | 'error'
        toastTimer: null
    };
};
