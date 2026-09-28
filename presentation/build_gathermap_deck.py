import os
import sys
from pptx import Presentation

if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

def create_deck():
    output_dir = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(output_dir, exist_ok=True)
    pptx_path = os.path.join(output_dir, "GatherMap_Classroom_Presentation.pptx")

    prs = Presentation()
    prs.slide_width = Inches(13.333)  # 16:9 Widescreen
    prs.slide_height = Inches(7.5)

    blank_layout = prs.slide_layouts[6]

    # ==========================================
    # COLOR PALETTE (GatherMap Dark Pro Theme)
    # ==========================================
    BG_DARK = RGBColor(11, 15, 25)          # #0B0F19 Deep background
    FRAME_BORDER = RGBColor(30, 41, 59)     # #1E293B Browser frame border
    FRAME_HEADER = RGBColor(15, 23, 42)     # #0F172A Window header
    CARD_BG = RGBColor(17, 24, 39)          # #111827 Main card surface
    CARD_INNER = RGBColor(26, 34, 52)       # #1A2234 Inner section surface
    BORDER_SUBTLE = RGBColor(51, 65, 85)    # #334155 Subtle outline

    AMBER = RGBColor(245, 158, 11)          # #F59E0B Brand Primary
    AMBER_LIGHT = RGBColor(254, 243, 199)   # #FEF3C7 Text highlight
    EMERALD = RGBColor(16, 185, 129)        # #10B981 Success / Vegan
    EMERALD_BG = RGBColor(6, 78, 59)        # Dark emerald
    BLUE_MAP = RGBColor(59, 130, 246)       # #3B82F6 GPS / Location
    PURPLE_AI = RGBColor(168, 85, 247)      # #A855F7 Gemini AI
    ROSE_RED = RGBColor(244, 63, 94)        # #F43F5E Constraints / Alert

    TEXT_WHITE = RGBColor(255, 255, 255)
    TEXT_LIGHT = RGBColor(226, 232, 240)    # #E2E8F0
    TEXT_MUTED = RGBColor(148, 163, 184)    # #94A3B8
    TEXT_DARK = RGBColor(15, 23, 42)

    # Helper: Slide Base Background
    def set_slide_background(slide):
        bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
        bg.fill.solid()
        bg.fill.fore_color.rgb = BG_DARK
        bg.line.fill.background()
        return bg

    # Helper: Browser Window Frame
    def add_browser_frame(slide, title_text, url_text):
        # Frame Container
        frame = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.6), Inches(0.4), Inches(12.133), Inches(6.7))
        frame.fill.solid()
        frame.fill.fore_color.rgb = CARD_BG
        frame.line.color.rgb = FRAME_BORDER
        frame.line.width = Pt(1.5)

        # Header Bar
        header = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.6), Inches(0.4), Inches(12.133), Inches(0.55))
        header.fill.solid()
        header.fill.fore_color.rgb = FRAME_HEADER
        header.line.color.rgb = FRAME_BORDER
        header.line.width = Pt(1)

        # 3 Window Buttons (Red, Yellow, Green)
        c_red = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(0.85), Inches(0.6), Inches(0.15), Inches(0.15))
        c_red.fill.solid()
        c_red.fill.fore_color.rgb = RGBColor(239, 68, 68)
        c_red.line.fill.background()

        c_yellow = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(1.08), Inches(0.6), Inches(0.15), Inches(0.15))
        c_yellow.fill.solid()
        c_yellow.fill.fore_color.rgb = RGBColor(245, 158, 11)
        c_yellow.line.fill.background()

        c_green = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(1.31), Inches(0.6), Inches(0.15), Inches(0.15))
        c_green.fill.solid()
        c_green.fill.fore_color.rgb = RGBColor(16, 185, 129)
        c_green.line.fill.background()

        # URL Pill
        url_box = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1.7), Inches(0.5), Inches(4.8), Inches(0.34))
        url_box.fill.solid()
        url_box.fill.fore_color.rgb = RGBColor(30, 41, 59)
        url_box.line.color.rgb = RGBColor(51, 65, 85)
        url_box.line.width = Pt(1)
        tf_url = url_box.text_frame
        tf_url.vertical_anchor = MSO_ANCHOR.MIDDLE
        tf_url.word_wrap = False
        tf_url.margin_left = Inches(0.15)
        p = tf_url.paragraphs[0]
        p.text = f"🔒 {url_text}"
        p.font.size = Pt(10)
        p.font.color.rgb = TEXT_LIGHT
        p.font.bold = False

        # App Title in Header
        app_title = slide.shapes.add_textbox(Inches(6.8), Inches(0.48), Inches(5.6), Inches(0.4))
        tf_title = app_title.text_frame
        tf_title.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = tf_title.paragraphs[0]
        p.alignment = PP_ALIGN.RIGHT
        p.text = title_text
        p.font.size = Pt(11)
        p.font.bold = True
        p.font.color.rgb = AMBER

        return frame

    # =========================================================================
    # SLIDE 1: The Input & Fair Gathering Dashboard (Pre-Search)
    # =========================================================================
    slide1 = prs.slides.add_slide(blank_layout)
    set_slide_background(slide1)
    add_browser_frame(slide1, "GATHERMAP • INPUT & COORDINATION DASHBOARD", "https://gathermap.app/session/EAT-2026")

    # ------------------ LEFT COLUMN: Wishes & Group Context Box ------------------
    left_x = Inches(0.9)
    left_w = Inches(5.4)

    # Section 1 Header: Group Members & Starting Points
    box_mems = slide1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left_x, Inches(1.15), left_w, Inches(2.2))
    box_mems.fill.solid()
    box_mems.fill.fore_color.rgb = CARD_INNER
    box_mems.line.color.rgb = BORDER_SUBTLE
    box_mems.line.width = Pt(1)

    tf = box_mems.text_frame
    tf.margin_left = Inches(0.2)
    tf.margin_top = Inches(0.12)
    tf.margin_right = Inches(0.2)
    p = tf.paragraphs[0]
    p.text = "👥 GROUP MEMBERS & STARTING LOCATIONS (4 Members)"
    p.font.size = Pt(10)
    p.font.bold = True
    p.font.color.rgb = AMBER

    # 4 Member Rows
    members_data = [
        ("An", "📍 Landmark 81, Bình Thạnh", "🌱 Vegetarian / Vegan diet only", BLUE_MAP),
        ("Bình", "📍 UEH Campus B, Quận 10", "🍵 Wants matcha & quiet corner for study", EMERALD),
        ("Chi", "📍 Hồ Con Rùa, Quận 3", "📸 Loves photogenic aesthetic & cafe space", PURPLE_AI),
        ("Dũng", "📍 Vạn Hạnh Mall, Quận 10", "💰 Budget strictly under 80,000 VND", AMBER)
    ]

    for idx, (name, loc, note, col) in enumerate(members_data):
        row_y = Inches(1.48 + idx * 0.43)
        row_box = slide1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1.05), row_y, Inches(5.1), Inches(0.38))
        row_box.fill.solid()
        row_box.fill.fore_color.rgb = RGBColor(15, 23, 42)
        row_box.line.color.rgb = RGBColor(30, 41, 59)
        row_box.line.width = Pt(1)

        tf_r = row_box.text_frame
        tf_r.vertical_anchor = MSO_ANCHOR.MIDDLE
        tf_r.margin_left = Inches(0.12)
        tf_r.margin_right = Inches(0.1)
        p = tf_r.paragraphs[0]
        run_name = p.add_run()
        run_name.text = f"● {name}: "
        run_name.font.bold = True
        run_name.font.size = Pt(9.5)
        run_name.font.color.rgb = col

        run_loc = p.add_run()
        run_loc.text = f"{loc}  —  "
        run_loc.font.size = Pt(8.5)
        run_loc.font.color.rgb = TEXT_LIGHT

        run_note = p.add_run()
        run_note.text = note
        run_note.font.size = Pt(8)
        run_note.font.italic = True
        run_note.font.color.rgb = TEXT_MUTED

    # Section 2: Representative "Wishes & Group Context" Textbox
    box_wishes = slide1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left_x, Inches(3.48), left_w, Inches(1.95))
    box_wishes.fill.solid()
    box_wishes.fill.fore_color.rgb = CARD_INNER
    box_wishes.line.color.rgb = PURPLE_AI
    box_wishes.line.width = Pt(1.5)

    tf_w = box_wishes.text_frame
    tf_w.margin_left = Inches(0.2)
    tf_w.margin_top = Inches(0.15)
    tf_w.margin_right = Inches(0.2)
    p = tf_w.paragraphs[0]
    p.text = "✨ REPRESENTATIVE'S WISHES & GROUP DISCUSSION BOX"
    p.font.size = Pt(10)
    p.font.bold = True
    p.font.color.rgb = PURPLE_AI

    p = tf_w.add_paragraph()
    p.text = "Paste freestyle Zalo/Mess chat or type group preferences. Gemini LLM parses criteria automatically:"
    p.font.size = Pt(8.5)
    p.font.color.rgb = TEXT_MUTED
    p.space_after = Pt(6)

    # Simulated Textarea Input Box
    textarea = slide1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1.05), Inches(4.05), Inches(5.1), Inches(1.25))
    textarea.fill.solid()
    textarea.fill.fore_color.rgb = RGBColor(11, 15, 25)
    textarea.line.color.rgb = RGBColor(79, 70, 229)
    textarea.line.width = Pt(1)

    tf_t = textarea.text_frame
    tf_t.margin_left = Inches(0.15)
    tf_t.margin_top = Inches(0.1)
    tf_t.margin_right = Inches(0.15)
    p = tf_t.paragraphs[0]
    p.text = '"An hôm nay ăn chay nha mn. Bình cần chỗ yên tĩnh có matcha để ôn thi cuối kỳ. Chi thích quán decor đẹp chụp hình check-in, còn Dũng thì budget dưới 80k/người thui. Kiếm quán nào công bằng ở giữa nha!"'
    p.font.size = Pt(9.5)
    p.font.italic = True
    p.font.color.rgb = RGBColor(224, 231, 255)

    # Section 3: Search Radius Selector & CTA Button
    rad_box = slide1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left_x, Inches(5.55), Inches(2.6), Inches(0.65))
    rad_box.fill.solid()
    rad_box.fill.fore_color.rgb = CARD_INNER
    rad_box.line.color.rgb = BORDER_SUBTLE
    rad_box.line.width = Pt(1)
    tf_rad = rad_box.text_frame
    tf_rad.margin_left = Inches(0.12)
    tf_rad.margin_top = Inches(0.08)
    p = tf_rad.paragraphs[0]
    p.text = "SEARCH RADIUS (DISCOVERY)"
    p.font.size = Pt(8)
    p.font.bold = True
    p.font.color.rgb = TEXT_MUTED
    p = tf_rad.add_paragraph()
    p.text = "1km   |   2km   |  [ 3km • Selected ]  |   5km"
    p.font.size = Pt(9)
    p.font.bold = True
    p.font.color.rgb = AMBER

    # CTA Button: Let's Go!
    cta_btn = slide1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(3.6), Inches(5.55), Inches(2.7), Inches(0.65))
    cta_btn.fill.solid()
    cta_btn.fill.fore_color.rgb = AMBER
    cta_btn.line.fill.background()
    tf_cta = cta_btn.text_frame
    tf_cta.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf_cta.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    p.text = "🚀 LET'S GO! (ANALYZE WITH AI)"
    p.font.size = Pt(11)
    p.font.bold = True
    p.font.color.rgb = TEXT_DARK

    # ------------------ RIGHT COLUMN: Spatial Interactive Map ------------------
    right_x = Inches(6.5)
    right_w = Inches(5.9)
    right_h = Inches(5.75)

    map_container = slide1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, right_x, Inches(1.15), right_w, right_h)
    map_container.fill.solid()
    map_container.fill.fore_color.rgb = RGBColor(15, 23, 42)
    map_container.line.color.rgb = BORDER_SUBTLE
    map_container.line.width = Pt(1.5)

    # Map Header / Legend Bar
    map_hdr = slide1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(6.7), Inches(1.3), Inches(5.5), Inches(0.45))
    map_hdr.fill.solid()
    map_hdr.fill.fore_color.rgb = RGBColor(30, 41, 59)
    map_hdr.line.color.rgb = BORDER_SUBTLE
    map_hdr.line.width = Pt(1)
    tf_mhdr = map_hdr.text_frame
    tf_mhdr.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf_mhdr.margin_left = Inches(0.15)
    p = tf_mhdr.paragraphs[0]
    p.text = "🗺️ INTERACTIVE MAP: REAL COORDINATES & WEISZFELD CENTER"
    p.font.size = Pt(9.5)
    p.font.bold = True
    p.font.color.rgb = TEXT_WHITE

    # Map Visual Graphic Elements
    # Radius Circle Boundary (Dotted ring)
    circle = slide1.shapes.add_shape(MSO_SHAPE.OVAL, Inches(7.4), Inches(2.3), Inches(4.2), Inches(3.7))
    circle.fill.background()
    circle.line.color.rgb = RGBColor(245, 158, 11)
    circle.line.width = Pt(1.5)

    # Weiszfeld Center Beacon (Glowing Bullseye)
    center_beacon = slide1.shapes.add_shape(MSO_SHAPE.OVAL, Inches(9.2), Inches(3.85), Inches(0.6), Inches(0.6))
    center_beacon.fill.solid()
    center_beacon.fill.fore_color.rgb = AMBER
    center_beacon.line.color.rgb = TEXT_WHITE
    center_beacon.line.width = Pt(2)

    center_label = slide1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(8.3), Inches(4.55), Inches(2.4), Inches(0.75))
    center_label.fill.solid()
    center_label.fill.fore_color.rgb = RGBColor(11, 15, 25)
    center_label.line.color.rgb = AMBER
    center_label.line.width = Pt(1.5)
    tf_cl = center_label.text_frame
    tf_cl.margin_left = Inches(0.1)
    tf_cl.margin_top = Inches(0.08)
    p = tf_cl.paragraphs[0]
    p.text = "🎯 WEISZFELD GEOMETRIC MEDIAN"
    p.font.size = Pt(8.5)
    p.font.bold = True
    p.font.color.rgb = AMBER
    p = tf_cl.add_paragraph()
    p.text = "District 10 (10.7769° N, 106.6780° E)\nEqual total travel • Outlier-resistant"
    p.font.size = Pt(7.5)
    p.font.color.rgb = TEXT_LIGHT

    # 4 Member Pins on Map with Connectors
    pins = [
        ("An (Landmark 81)", Inches(11.1), Inches(2.1), BLUE_MAP, "3.8 km travel"),
        ("Bình (UEH B, Q10)", Inches(7.2), Inches(4.7), EMERALD, "1.2 km travel"),
        ("Chi (Hồ Con Rùa)", Inches(9.8), Inches(2.1), PURPLE_AI, "2.1 km travel"),
        ("Dũng (Vạn Hạnh Mall)", Inches(7.3), Inches(3.2), AMBER, "1.4 km travel")
    ]

    for name, px, py, pcol, dist in pins:
        pin = slide1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, px, py, Inches(1.35), Inches(0.55))
        pin.fill.solid()
        pin.fill.fore_color.rgb = RGBColor(15, 23, 42)
        pin.line.color.rgb = pcol
        pin.line.width = Pt(1.5)
        tf_p = pin.text_frame
        tf_p.margin_left = Inches(0.08)
        tf_p.margin_top = Inches(0.06)
        p = tf_p.paragraphs[0]
        p.text = name
        p.font.size = Pt(8)
        p.font.bold = True
        p.font.color.rgb = pcol
        p = tf_p.add_paragraph()
        p.text = f"➔ {dist}"
        p.font.size = Pt(7.5)
        p.font.color.rgb = TEXT_MUTED

    # Bottom Map Note
    map_note = slide1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(6.7), Inches(6.25), Inches(5.5), Inches(0.5))
    map_note.fill.solid()
    map_note.fill.fore_color.rgb = RGBColor(20, 27, 45)
    map_note.line.color.rgb = BORDER_SUBTLE
    map_note.line.width = Pt(1)
    tf_mn = map_note.text_frame
    tf_mn.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf_mn.margin_left = Inches(0.12)
    p = tf_mn.paragraphs[0]
    p.text = "💡 Mathematical Edge: Eliminates center-drift caused by extreme outliers (unlike centroid average)."
    p.font.size = Pt(8.5)
    p.font.color.rgb = AMBER_LIGHT

    # =========================================================================
    # SLIDE 2: Demonstrating AI / LLM Execution (The Brain)
    # =========================================================================
    slide2 = prs.slides.add_slide(blank_layout)
    set_slide_background(slide2)

    # Top Header Banner
    header_box2 = slide2.shapes.add_textbox(Inches(0.8), Inches(0.4), Inches(11.733), Inches(0.95))
    tf2 = header_box2.text_frame
    tf2.word_wrap = True
    p = tf2.paragraphs[0]
    p.text = "AI REASONING CORE • GOOGLE GEMINI 3.8 FLASH"
    p.font.size = Pt(11)
    p.font.bold = True
    p.font.color.rgb = PURPLE_AI

    p2 = tf2.add_paragraph()
    p2.text = "How AI Transforms Chaotic Chat Messages into Structured Decision Logic"
    p2.font.size = Pt(22)
    p2.font.bold = True
    p2.font.color.rgb = TEXT_WHITE

    # 3 Architecture Columns
    col_w = Inches(3.75)
    col_h = Inches(5.6)
    col_y = Inches(1.45)

    # ------------------ COLUMN 1: Raw Chaotic Group Chat ------------------
    c1 = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.8), col_y, col_w, col_h)
    c1.fill.solid()
    c1.fill.fore_color.rgb = CARD_BG
    c1.line.color.rgb = BORDER_SUBTLE
    c1.line.width = Pt(1.5)

    tf = c1.text_frame
    tf.margin_left = Inches(0.22)
    tf.margin_top = Inches(0.2)
    tf.margin_right = Inches(0.22)
    p = tf.paragraphs[0]
    p.text = "STEP 1: UNSTRUCTURED INPUT"
    p.font.size = Pt(9.5)
    p.font.bold = True
    p.font.color.rgb = BLUE_MAP
    p = tf.add_paragraph()
    p.text = "Chaotic Group Chat Stream"
    p.font.size = Pt(15)
    p.font.bold = True
    p.font.color.rgb = TEXT_WHITE
    p.space_after = Pt(10)

    # Chat Bubbles inside Col 1
    chat_messages = [
        ("An (10:15 AM)", "Ê trưa nay đi đâu mn ơi? Tui đang ăn chay nha, đừng dẫn đi quán nướng 🥩❌", RGBColor(30, 41, 59)),
        ("Bình (10:16 AM)", "Tìm quán nào yên tĩnh xíu ngồi học bài nha, có matcha latte càng tốt 🍵📚", RGBColor(30, 41, 59)),
        ("Chi (10:18 AM)", "Decor đẹp chụp hình sống ảo xíu nha quý zị, gần Q10 thui đi xa nắng lắm 📸☀️", RGBColor(30, 41, 59)),
        ("Dũng (10:19 AM)", "Cuối tháng kẹt tiền lắm ae, budget < 80k/người thui nhé! 💸", RGBColor(30, 41, 59))
    ]

    for idx, (sender, msg, bg_c) in enumerate(chat_messages):
        cb = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.95), Inches(2.45 + idx * 0.8), Inches(3.45), Inches(0.72))
        cb.fill.solid()
        cb.fill.fore_color.rgb = bg_c
        cb.line.color.rgb = RGBColor(51, 65, 85)
        cb.line.width = Pt(1)
        tf_cb = cb.text_frame
        tf_cb.margin_left = Inches(0.12)
        tf_cb.margin_top = Inches(0.06)
        tf_cb.margin_right = Inches(0.12)
        p = tf_cb.paragraphs[0]
        p.text = sender
        p.font.size = Pt(8)
        p.font.bold = True
        p.font.color.rgb = AMBER
        p = tf_cb.add_paragraph()
        p.text = msg
        p.font.size = Pt(8)
        p.font.color.rgb = TEXT_LIGHT

    # Pain points footer in Col 1
    pp_box = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.95), Inches(5.85), Inches(3.45), Inches(1.0))
    pp_box.fill.solid()
    pp_box.fill.fore_color.rgb = RGBColor(39, 15, 20)
    pp_box.line.color.rgb = ROSE_RED
    pp_box.line.width = Pt(1)
    tf_pp = pp_box.text_frame
    tf_pp.margin_left = Inches(0.12)
    tf_pp.margin_top = Inches(0.08)
    p = tf_pp.paragraphs[0]
    p.text = "⚠️ THE GROUP PAIN POINT"
    p.font.size = Pt(8.5)
    p.font.bold = True
    p.font.color.rgb = ROSE_RED
    p = tf_pp.add_paragraph()
    p.text = "Human coordination fails: Conflicting dietary rules, disparate budgets, and location deadlock cause group indecision."
    p.font.size = Pt(8)
    p.font.color.rgb = TEXT_LIGHT

    # ------------------ COLUMN 2: Gemini 3.8 Flash Parser ------------------
    c2 = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(4.78), col_y, col_w, col_h)
    c2.fill.solid()
    c2.fill.fore_color.rgb = CARD_BG
    c2.line.color.rgb = PURPLE_AI
    c2.line.width = Pt(2)

    tf = c2.text_frame
    tf.margin_left = Inches(0.22)
    tf.margin_top = Inches(0.2)
    tf.margin_right = Inches(0.22)
    p = tf.paragraphs[0]
    p.text = "STEP 2: GEMINI 3.8 FLASH PARSING"
    p.font.size = Pt(9.5)
    p.font.bold = True
    p.font.color.rgb = PURPLE_AI
    p = tf.add_paragraph()
    p.text = "Two-Stage Semantic Engine"
    p.font.size = Pt(15)
    p.font.bold = True
    p.font.color.rgb = TEXT_WHITE
    p.space_after = Pt(10)

    # Sub-Box A: Hard Constraints (Non-Negotiable)
    hard_box = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(4.95), Inches(2.45), Inches(3.4), Inches(1.55))
    hard_box.fill.solid()
    hard_box.fill.fore_color.rgb = RGBColor(20, 30, 45)
    hard_box.line.color.rgb = EMERALD
    hard_box.line.width = Pt(1.5)
    tf_h = hard_box.text_frame
    tf_h.margin_left = Inches(0.12)
    tf_h.margin_top = Inches(0.08)
    p = tf_h.paragraphs[0]
    p.text = "STAGE 2A: HARD CONSTRAINTS (Zero-Tolerate)"
    p.font.size = Pt(8.5)
    p.font.bold = True
    p.font.color.rgb = EMERALD
    p = tf_h.add_paragraph()
    p.text = "• vegetarianRequired: true (An's health/belief)\n• noAlcohol: true (Safe group outing)\n• maxPriceVnd: 80,000 VND (Dũng's budget ceiling)\n• radiusMeters: <= 3,000m (Weiszfeld circle)"
    p.font.size = Pt(8)
    p.font.color.rgb = TEXT_LIGHT

    # Sub-Box B: Soft Preferences (Weighted Vibe & Taste)
    soft_box = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(4.95), Inches(4.15), Inches(3.4), Inches(1.55))
    soft_box.fill.solid()
    soft_box.fill.fore_color.rgb = RGBColor(25, 20, 45)
    soft_box.line.color.rgb = PURPLE_AI
    soft_box.line.width = Pt(1.5)
    tf_s = soft_box.text_frame
    tf_s.margin_left = Inches(0.12)
    tf_s.margin_top = Inches(0.08)
    p = tf_s.paragraphs[0]
    p.text = "STAGE 2B: WEIGHTED SOFT PREFERENCES"
    p.font.size = Pt(8.5)
    p.font.bold = True
    p.font.color.rgb = PURPLE_AI
    p = tf_s.add_paragraph()
    p.text = "• Matcha Specialty Beverage: Weight 5/5 (Bình)\n• Quiet Workspace / Study Vibe: Weight 5/5 (Bình)\n• Photogenic / Aesthetic Decor: Weight 4/5 (Chi)\n• Spacious Group Seating: Weight 4/5 (Group)"
    p.font.size = Pt(8)
    p.font.color.rgb = TEXT_LIGHT

    # Sub-Box C: Confirmation Modal Notice
    conf_box = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(4.95), Inches(5.85), Inches(3.4), Inches(1.0))
    conf_box.fill.solid()
    conf_box.fill.fore_color.rgb = RGBColor(30, 41, 59)
    conf_box.line.color.rgb = BORDER_SUBTLE
    conf_box.line.width = Pt(1)
    tf_cf = conf_box.text_frame
    tf_cf.margin_left = Inches(0.12)
    tf_cf.margin_top = Inches(0.08)
    p = tf_cf.paragraphs[0]
    p.text = "🛡️ HUMAN-IN-THE-LOOP SAFEGUARD"
    p.font.size = Pt(8.5)
    p.font.bold = True
    p.font.color.rgb = AMBER
    p = tf_cf.add_paragraph()
    p.text = "Confirmation Experience Modal lets the representative verify, toggle, or edit tags before database execution."
    p.font.size = Pt(8)
    p.font.color.rgb = TEXT_LIGHT

    # ------------------ COLUMN 3: Mathematical Fairness & Matching ------------------
    c3 = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(8.75), col_y, col_w, col_h)
    c3.fill.solid()
    c3.fill.fore_color.rgb = CARD_BG
    c3.line.color.rgb = BORDER_SUBTLE
    c3.line.width = Pt(1.5)

    tf = c3.text_frame
    tf.margin_left = Inches(0.22)
    tf.margin_top = Inches(0.2)
    tf.margin_right = Inches(0.22)
    p = tf.paragraphs[0]
    p.text = "STEP 3: ALGORITHMIC FAIRNESS"
    p.font.size = Pt(9.5)
    p.font.bold = True
    p.font.color.rgb = AMBER
    p = tf.add_paragraph()
    p.text = "The 65/35 Egalitarian Model"
    p.font.size = Pt(15)
    p.font.bold = True
    p.font.color.rgb = TEXT_WHITE
    p.space_after = Pt(10)

    # Formula Card in Col 3
    form_box = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(8.92), Inches(2.45), Inches(3.4), Inches(1.55))
    form_box.fill.solid()
    form_box.fill.fore_color.rgb = RGBColor(30, 25, 15)
    form_box.line.color.rgb = AMBER
    form_box.line.width = Pt(1.5)
    tf_fm = form_box.text_frame
    tf_fm.margin_left = Inches(0.12)
    tf_fm.margin_top = Inches(0.08)
    p = tf_fm.paragraphs[0]
    p.text = "📐 CORE FAIRNESS SPECIFICATION"
    p.font.size = Pt(8.5)
    p.font.bold = True
    p.font.color.rgb = AMBER
    p = tf_fm.add_paragraph()
    p.text = "Group Score = 0.65 × Avg + 0.35 × Min"
    p.font.size = Pt(11)
    p.font.bold = True
    p.font.color.rgb = AMBER_LIGHT
    p.space_after = Pt(4)
    p = tf_fm.add_paragraph()
    p.text = "• 65% Group Average: Satisfies general collective taste.\n• 35% Minimum Satisfaction: Protects the most vulnerable member (Anti-Tyranny guarantee!)."
    p.font.size = Pt(8)
    p.font.color.rgb = TEXT_LIGHT

    # Database Matching Box
    db_box = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(8.92), Inches(4.15), Inches(3.4), Inches(1.55))
    db_box.fill.solid()
    db_box.fill.fore_color.rgb = RGBColor(15, 23, 42)
    db_box.line.color.rgb = BLUE_MAP
    db_box.line.width = Pt(1.5)
    tf_db = db_box.text_frame
    tf_db.margin_left = Inches(0.12)
    tf_db.margin_top = Inches(0.08)
    p = tf_db.paragraphs[0]
    p.text = "🗄️ PROVENANCE-BACKED VENUE DATABASE"
    p.font.size = Pt(8.5)
    p.font.bold = True
    p.font.color.rgb = BLUE_MAP
    p = tf_db.add_paragraph()
    p.text = "• 40+ Curated District 10 Venues (Cafes, Milk Tea, Desserts, Malls)\n• 50+ Real Reviewer Insights (Google Maps, TikTok KOC, Foody)\n• Pre-computed semantic profiles: Noise level, parking, vegetarian viability"
    p.font.size = Pt(8)
    p.font.color.rgb = TEXT_LIGHT

    # Resulting Verdict in Col 3
    res_box = slide2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(8.92), Inches(5.85), Inches(3.4), Inches(1.0))
    res_box.fill.solid()
    res_box.fill.fore_color.rgb = RGBColor(6, 78, 59)
    res_box.line.color.rgb = EMERALD
    res_box.line.width = Pt(1)
    tf_res = res_box.text_frame
    tf_res.margin_left = Inches(0.12)
    tf_res.margin_top = Inches(0.08)
    p = tf_res.paragraphs[0]
    p.text = "✅ PREDICTABLE, AUDITABLE DECISION"
    p.font.size = Pt(8.5)
    p.font.bold = True
    p.font.color.rgb = EMERALD
    p = tf_res.add_paragraph()
    p.text = "Returns an instant Top 3 shortlist with transparent reasons & compromises for every individual friend."
    p.font.size = Pt(8)
    p.font.color.rgb = TEXT_LIGHT

    # =========================================================================
    # SLIDE 3: Proposed Results Dashboard (Venue Card Based on User's Sketch)
    # =========================================================================
    slide3 = prs.slides.add_slide(blank_layout)
    set_slide_background(slide3)
    add_browser_frame(slide3, "GATHERMAP • RECOMMENDATION RESULTS DASHBOARD", "https://gathermap.app/session/EAT-2026/shortlist")

    # ------------------ LEFT COLUMN: The User's Sketched Card ------------------
    card_x = Inches(0.9)
    card_w = Inches(5.7)
    card_y = Inches(1.15)
    card_h = Inches(5.75)

    venue_card = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, card_x, card_y, card_w, card_h)
    venue_card.fill.solid()
    venue_card.fill.fore_color.rgb = CARD_BG
    venue_card.line.color.rgb = AMBER
    venue_card.line.width = Pt(2)

    # 1. TOP SECTION: Real Photographs of the Venue (User's Sketch Top Box)
    photo_banner = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1.05), Inches(1.3), Inches(5.4), Inches(1.5))
    photo_banner.fill.solid()
    photo_banner.fill.fore_color.rgb = RGBColor(26, 34, 52)
    photo_banner.line.color.rgb = RGBColor(51, 65, 85)
    photo_banner.line.width = Pt(1)

    # Badges overlaid on top of photo
    badge_rank = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1.2), Inches(1.42), Inches(1.4), Inches(0.32))
    badge_rank.fill.solid()
    badge_rank.fill.fore_color.rgb = AMBER
    badge_rank.line.fill.background()
    tf_br = badge_rank.text_frame
    tf_br.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf_br.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    p.text = "🏆 #1 TOP MATCH"
    p.font.size = Pt(8.5)
    p.font.bold = True
    p.font.color.rgb = TEXT_DARK

    badge_status = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(2.7), Inches(1.42), Inches(1.7), Inches(0.32))
    badge_status.fill.solid()
    badge_status.fill.fore_color.rgb = EMERALD_BG
    badge_status.line.color.rgb = EMERALD
    badge_status.line.width = Pt(1)
    tf_bs = badge_status.text_frame
    tf_bs.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf_bs.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    p.text = "🟢 OPEN (07:00 - 23:00)"
    p.font.size = Pt(8)
    p.font.bold = True
    p.font.color.rgb = EMERALD

    badge_score = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(5.1), Inches(1.42), Inches(1.2), Inches(0.32))
    badge_score.fill.solid()
    badge_score.fill.fore_color.rgb = RGBColor(11, 15, 25)
    badge_score.line.color.rgb = AMBER
    badge_score.line.width = Pt(1)
    tf_sc = badge_score.text_frame
    tf_sc.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf_sc.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    p.text = "⭐ 92 / 100"
    p.font.size = Pt(9)
    p.font.bold = True
    p.font.color.rgb = AMBER

    # Venue Name & Category in Photo Banner
    tf_pb = photo_banner.text_frame
    tf_pb.margin_left = Inches(0.2)
    tf_pb.margin_top = Inches(0.65)
    p = tf_pb.paragraphs[0]
    p.text = "PHÊ LA — CƯ XÁ BẮC HẢI"
    p.font.size = Pt(14)
    p.font.bold = True
    p.font.color.rgb = TEXT_WHITE
    p = tf_pb.add_paragraph()
    p.text = "Specialty Oolong Tea, Camp Style & Quiet Study Nook  •  45,000 - 75,000 VND"
    p.font.size = Pt(8.5)
    p.font.color.rgb = AMBER_LIGHT

    # 2. MIDDLE SECTION: General Info About the Venue (User's Sketch Middle Circle)
    mid_box = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1.05), Inches(2.9), Inches(5.4), Inches(2.35))
    mid_box.fill.solid()
    mid_box.fill.fore_color.rgb = CARD_INNER
    mid_box.line.color.rgb = BORDER_SUBTLE
    mid_box.line.width = Pt(1)

    tf_m = mid_box.text_frame
    tf_m.margin_left = Inches(0.18)
    tf_m.margin_top = Inches(0.12)
    tf_m.margin_right = Inches(0.18)
    p = tf_m.paragraphs[0]
    p.text = "📍 125 Cư Xá Bắc Hải, Phường 15, Quận 10  (1.1 km from Weiszfeld center ~ 4 mins)"
    p.font.size = Pt(8.5)
    p.font.bold = True
    p.font.color.rgb = TEXT_LIGHT
    p.space_after = Pt(4)

    # Gemini AI Concierge Rationale Box
    ai_callout = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1.2), Inches(3.3), Inches(5.1), Inches(0.95))
    ai_callout.fill.solid()
    ai_callout.fill.fore_color.rgb = RGBColor(25, 20, 45)
    ai_callout.line.color.rgb = PURPLE_AI
    ai_callout.line.width = Pt(1)
    tf_ai = ai_callout.text_frame
    tf_ai.margin_left = Inches(0.12)
    tf_ai.margin_top = Inches(0.06)
    tf_ai.margin_right = Inches(0.12)
    p = tf_ai.paragraphs[0]
    p.text = "✨ GEMINI AI CONCIERGE RATIONALE:"
    p.font.size = Pt(8.5)
    p.font.bold = True
    p.font.color.rgb = PURPLE_AI
    p = tf_ai.add_paragraph()
    p.text = '"Perfect harmony: Features Oolong Matcha Latte satisfying Bình (96%), pure plant-based tea drinks meeting An\'s vegan rule (90%), trendy aesthetic camp seating for Chi (88%), and drinks priced 55k-65k well within Dũng\'s 80k budget (94%)."'
    p.font.size = Pt(8)
    p.font.italic = True
    p.font.color.rgb = RGBColor(224, 231, 255)

    # Member Satisfaction Breakdown Meters (Inside Middle Section)
    m_score_label = slide3.shapes.add_textbox(Inches(1.2), Inches(4.3), Inches(5.1), Inches(0.25))
    tf_msl = m_score_label.text_frame
    p = tf_msl.paragraphs[0]
    p.text = "INDIVIDUAL MEMBER SATISFACTION BREAKDOWN:"
    p.font.size = Pt(7.5)
    p.font.bold = True
    p.font.color.rgb = TEXT_MUTED

    scores = [
        ("An (Vegan)", "90%", EMERALD),
        ("Bình (Quiet/Matcha)", "96%", PURPLE_AI),
        ("Chi (Aesthetic)", "88%", BLUE_MAP),
        ("Dũng (Budget <80k)", "94%", AMBER)
    ]
    for idx, (mname, msc, mcol) in enumerate(scores):
        m_meter = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1.2 + idx * 1.3), Inches(4.6), Inches(1.2), Inches(0.52))
        m_meter.fill.solid()
        m_meter.fill.fore_color.rgb = RGBColor(15, 23, 42)
        m_meter.line.color.rgb = mcol
        m_meter.line.width = Pt(1)
        tf_mm = m_meter.text_frame
        tf_mm.margin_left = Inches(0.06)
        tf_mm.margin_top = Inches(0.04)
        p = tf_mm.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        p.text = msc
        p.font.size = Pt(10)
        p.font.bold = True
        p.font.color.rgb = mcol
        p = tf_mm.add_paragraph()
        p.alignment = PP_ALIGN.CENTER
        p.text = mname
        p.font.size = Pt(6.5)
        p.font.color.rgb = TEXT_LIGHT

    # 3. BOTTOM SECTION: Interactive Action Pills (Matching User's Sketch Arrows)
    arrow_label = slide3.shapes.add_textbox(Inches(1.05), Inches(5.32), Inches(5.4), Inches(0.25))
    tf_al = arrow_label.text_frame
    p = tf_al.paragraphs[0]
    p.text = "INTERACTIVE BOTTOM ACTION PILLS (From Your Layout Sketch):"
    p.font.size = Pt(7.5)
    p.font.bold = True
    p.font.color.rgb = AMBER

    # Button 1: Reviews of other users (Bottom Drawer)
    btn_reviews = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1.05), Inches(5.62), Inches(1.65), Inches(1.12))
    btn_reviews.fill.solid()
    btn_reviews.fill.fore_color.rgb = RGBColor(15, 23, 42)
    btn_reviews.line.color.rgb = BLUE_MAP
    btn_reviews.line.width = Pt(1.5)
    tf_brv = btn_reviews.text_frame
    tf_brv.margin_left = Inches(0.08)
    tf_brv.margin_top = Inches(0.06)
    p = tf_brv.paragraphs[0]
    p.text = "💬 USER REVIEWS"
    p.font.size = Pt(8)
    p.font.bold = True
    p.font.color.rgb = BLUE_MAP
    p = tf_brv.add_paragraph()
    p.text = "⭐ 4.6 (120+ verified)\n• TikTok: Chill vibe\n• Google: Easy parking\n• Foody: Good tea"
    p.font.size = Pt(7)
    p.font.color.rgb = TEXT_LIGHT

    # Button 2: Menu & Pricing
    btn_menu = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(2.8), Inches(5.62), Inches(1.55), Inches(1.12))
    btn_menu.fill.solid()
    btn_menu.fill.fore_color.rgb = RGBColor(15, 23, 42)
    btn_menu.line.color.rgb = AMBER
    btn_menu.line.width = Pt(1.5)
    tf_bm = btn_menu.text_frame
    tf_bm.margin_left = Inches(0.08)
    tf_bm.margin_top = Inches(0.06)
    p = tf_bm.paragraphs[0]
    p.text = "🏷️ MENU & PRICES"
    p.font.size = Pt(8)
    p.font.bold = True
    p.font.color.rgb = AMBER
    p = tf_bm.add_paragraph()
    p.text = "45k - 75k VND\n• Ô long Khói (55k)\n• Matcha Latte (65k)\n• Bánh ngọt (35k)"
    p.font.size = Pt(7)
    p.font.color.rgb = TEXT_LIGHT

    # Button 3: Group Voting & 1-Click Google Maps Nav
    btn_action = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(4.45), Inches(5.62), Inches(2.0), Inches(1.12))
    btn_action.fill.solid()
    btn_action.fill.fore_color.rgb = RGBColor(6, 78, 59)
    btn_action.line.color.rgb = EMERALD
    btn_action.line.width = Pt(1.5)
    tf_ba = btn_action.text_frame
    tf_ba.margin_left = Inches(0.08)
    tf_ba.margin_top = Inches(0.06)
    p = tf_ba.paragraphs[0]
    p.text = "🧭 1-CLICK NAVIGATION"
    p.font.size = Pt(8)
    p.font.bold = True
    p.font.color.rgb = EMERALD
    p = tf_ba.add_paragraph()
    p.text = "🗳️ Vote: 3/4 Approved!\n➔ Launch Google Maps\nDirect Turn-by-Turn GPS"
    p.font.size = Pt(7)
    p.font.color.rgb = TEXT_LIGHT

    # ------------------ RIGHT COLUMN: Result Map & Runners-Up ------------------
    right_x3 = Inches(6.8)
    right_w3 = Inches(5.6)

    # Top: Live Route Convergence Map
    route_map = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, right_x3, Inches(1.15), right_w3, Inches(2.9))
    route_map.fill.solid()
    route_map.fill.fore_color.rgb = RGBColor(15, 23, 42)
    route_map.line.color.rgb = BORDER_SUBTLE
    route_map.line.width = Pt(1.5)

    tf_rm = route_map.text_frame
    tf_rm.margin_left = Inches(0.18)
    tf_rm.margin_top = Inches(0.12)
    p = tf_rm.paragraphs[0]
    p.text = "🗺️ LIVE ROUTE CONVERGENCE & TRAVEL TIMES"
    p.font.size = Pt(9.5)
    p.font.bold = True
    p.font.color.rgb = TEXT_WHITE
    p = tf_rm.add_paragraph()
    p.text = "All member routes converge onto Phê La (125 Cư Xá Bắc Hải):"
    p.font.size = Pt(8)
    p.font.color.rgb = TEXT_MUTED

    # Route travel items
    route_items = [
        ("An from Landmark 81:", "3.9 km  (~12 mins via Điện Biên Phủ / CMT8)", BLUE_MAP),
        ("Bình from UEH Campus B:", "1.1 km  (~4 mins via Nguyễn Tri Phương)", EMERALD),
        ("Chi from Hồ Con Rùa:", "2.2 km  (~7 mins via 3 Tháng 2)", PURPLE_AI),
        ("Dũng from Vạn Hạnh Mall:", "1.3 km  (~4 mins via Sư Vạn Hạnh)", AMBER)
    ]
    for idx, (rt_title, rt_det, rt_col) in enumerate(route_items):
        r_box = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(7.0), Inches(1.85 + idx * 0.48), Inches(5.2), Inches(0.42))
        r_box.fill.solid()
        r_box.fill.fore_color.rgb = RGBColor(26, 34, 52)
        r_box.line.color.rgb = RGBColor(51, 65, 85)
        r_box.line.width = Pt(1)
        tf_rt = r_box.text_frame
        tf_rt.vertical_anchor = MSO_ANCHOR.MIDDLE
        tf_rt.margin_left = Inches(0.12)
        p = tf_rt.paragraphs[0]
        run1 = p.add_run()
        run1.text = f"{rt_title} "
        run1.font.bold = True
        run1.font.size = Pt(8.5)
        run1.font.color.rgb = rt_col
        run2 = p.add_run()
        run2.text = rt_det
        run2.font.size = Pt(8)
        run2.font.color.rgb = TEXT_LIGHT

    # Bottom: Ranked Alternatives (Runner-Up Candidates)
    alt_box = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, right_x3, Inches(4.2), right_w3, Inches(2.7))
    alt_box.fill.solid()
    alt_box.fill.fore_color.rgb = CARD_BG
    alt_box.line.color.rgb = BORDER_SUBTLE
    alt_box.line.width = Pt(1.5)

    tf_alt = alt_box.text_frame
    tf_alt.margin_left = Inches(0.18)
    tf_alt.margin_top = Inches(0.12)
    p = tf_alt.paragraphs[0]
    p.text = "🥈 RUNNER-UP ALTERNATIVE RECOMMENDATIONS"
    p.font.size = Pt(9.5)
    p.font.bold = True
    p.font.color.rgb = AMBER
    p = tf_alt.add_paragraph()
    p.text = "Transparent comparison allows quick group voting switch if desired:"
    p.font.size = Pt(8)
    p.font.color.rgb = TEXT_MUTED

    runners = [
        ("#2", "Dallas Cakes & Cafe", "Score: 86/100 • 1.4 km", "Great desserts (An & Chi), slightly pricier (70k-85k)"),
        ("#3", "Chidori Coffee in Bed", "Score: 84/100 • 1.8 km", "Ultra quiet study pods (Bình 98%), but booking required")
    ]
    for idx, (rk, rname, rsc, rtrade) in enumerate(runners):
        rn_card = slide3.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(7.0), Inches(4.85 + idx * 0.9), Inches(5.2), Inches(0.8))
        rn_card.fill.solid()
        rn_card.fill.fore_color.rgb = CARD_INNER
        rn_card.line.color.rgb = BORDER_SUBTLE
        rn_card.line.width = Pt(1)
        tf_rn = rn_card.text_frame
        tf_rn.margin_left = Inches(0.15)
        tf_rn.margin_top = Inches(0.08)
        p = tf_rn.paragraphs[0]
        run_rk = p.add_run()
        run_rk.text = f"{rk} {rname}  "
        run_rk.font.bold = True
        run_rk.font.size = Pt(9)
        run_rk.font.color.rgb = TEXT_WHITE
        run_sc = p.add_run()
        run_sc.text = f"({rsc})"
        run_sc.font.size = Pt(8.5)
        run_sc.font.color.rgb = AMBER
        p = tf_rn.add_paragraph()
        p.text = f"Compromise: {rtrade}"
        p.font.size = Pt(7.5)
        p.font.color.rgb = TEXT_MUTED

    prs.save(pptx_path)
    print(f"✅ Successfully compiled presentation deck: {pptx_path}")
    return pptx_path

if __name__ == "__main__":
    create_deck()
