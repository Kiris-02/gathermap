/**
 * GatherMap Application Root Entrypoint
 * Stitches together reactive state, map controller, outing session, and UI modules for Alpine.js.
 * Preserves dynamic property getters and method descriptors across modular controllers.
 */
function gatherApp() {
    const app = {
        ...window.createInitialState(),

        async initApp() {
            // 1. Fetch backend config
            window.ApiClient.get('/api/config')
                .then(cfg => {
                    if (cfg) this.backendConfig = cfg;
                })
                .catch(() => {});

            // 2. Initialize keyboard shortcuts (ESC)
            this.initKeyboardShortcuts();

            // 3. Initialize Map & Geometry
            this.$nextTick(async () => {
                this.initMap();
                await this.fetchPresets();
                await this.initOutingSession();

                if (!this.shortlist || this.shortlist.length === 0) {
                    await this.calculateCenter();
                    await this.executeSearchAndRank();
                }
            });

            // 4. Responsive map resize watcher
            window.addEventListener('resize', () => {
                if (this.map && typeof this.map.invalidateSize === 'function') {
                    this.map.invalidateSize();
                }
            });
        }
    };

    // Safely copy controller descriptors preserving getters and methods
    const controllers = [
        window.createNotificationsController(),
        window.createVenueCardController(),
        window.createModalsController(),
        window.createMapController(),
        window.createOutingController(),
        window.createRecommendationController(),
        window.createReviewController()
    ];

    for (const ctrl of controllers) {
        Object.defineProperties(app, Object.getOwnPropertyDescriptors(ctrl));
    }

    return app;
}

window.gatherApp = gatherApp;
