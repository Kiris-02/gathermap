# Group Eatery Recommendation App
## Product and Technical Specification (Version 1 Product Definition)

Group Eatery Recommendation App

Product and Technical Specification

Version 1 Product Definition

12 September 2026

Purpose

This report defines the first buildable version of an application that helps a group choose an eatery from natural language preferences and participant locations. It records the agreed product rules, recommends a technical design, and gives a practical plan for validation and delivery.

Core decision

The application calculates a central search point from participant locations, lets the representative choose a search radius, filters the venue database to that circle, and ranks the remaining venues only by the group’s stated preferences.

Executive Summary

The product solves a narrow but frequent problem: a group knows it wants to eat together, yet its members have different tastes, budgets, constraints, and starting locations. Existing map and review products make each person search independently. This application collects the group’s wishes once, turns them into comparable criteria, and produces a small set of recommendations that the group can understand and act on.

Version 1 focuses on eateries, including formal restaurants, cafes, food stalls, and small alley venues. A representative can enter all locations and preferences, or signed-in users can join a temporary outing and provide their own information. The group center is calculated with a geometric median because it minimizes total straight-line travel and resists distortion from one distant participant. The representative can adjust that center and selects the radius that defines the eligible venue circle.

The language model interprets discussion and returns structured preferences. Application code applies required constraints and calculates repeatable scores. Each member receives an individual satisfaction score; the group score combines average satisfaction with the lowest individual score. The design favors venues that work well for the group without hiding a member who is poorly served.

The hardest product problem is venue data, especially subjective attributes such as noise, authenticity, seating comfort, or suitability for a long conversation. The hybrid database therefore combines external place identifiers and coordinates with first-party, curated venue descriptions. Every relevant attribute carries provenance, confidence, and freshness information.

Agreed Product Rules

Area

Rule

Initial category

Eateries ranging from restaurants to small alley venues

Participation

Representative entry and temporary connected group sessions

Group center

Geometric median of the supplied participant locations

Search boundary

Representative-selected circle around the calculated or adjusted center

Location in ranking

Location filters eligibility and does not affect ranking inside the circle

Preference ranking

Required constraints first, then weighted individual and group satisfaction

Opening hours

Excluded from initial matching and left for users to check in Google Maps

Collaboration

Available only to users joined to the same temporary outing

Navigation

Open the chosen venue in Google Maps after selection

Venue data

Hybrid external data and first-party curated information

Contents

1 Product Definition

2 Scope

3 Users and Participation Modes

4 Product Flow

5 Functional Requirements

6 Location Determination

7 Preference Interpretation

8 Venue Eligibility and Ranking

9 Recommendation Experience

10 Temporary Group Collaboration

11 Hybrid Venue Database

12 Data Model

13 System Architecture

14 Application Interfaces

15 Language Model Contract

16 Privacy and Security

17 Quality and Evaluation

18 Delivery Plan

19 Risks and Controls

20 Acceptance Criteria

21 Open Product Decisions

Appendix A Example Structured Data

Appendix B Scoring Example

References

1 Product Definition

1 1 Problem

Group food decisions are slow because preferences arrive in conversational fragments. One person may care about price, another has a dietary requirement, another wants a quiet place, and another suggests a specific cuisine. The group also starts from several locations. A representative usually carries the mental work of interpreting these wishes, searching maps, comparing places, and defending a final suggestion.

1 2 Product Purpose

The application converts the group’s conversation and locations into a transparent shortlist. It should reduce the time between deciding to meet and choosing a venue while preserving the group’s ability to review, discuss, and override the recommendation.

1 3 Product Promise

For a group that wants to eat together, the application will calculate a sensible search center, limit candidates to a chosen area, interpret each person’s wishes, and show three to five venues with clear reasons and tradeoffs.

1 4 Design Principles

• Location decides the candidate set before preference ranking begins.

• Users can inspect and correct what the language model understood.

• A recommendation explains whose preferences it serves and where it compromises.

• Unknown venue information stays unknown and remains visible to the user.

• Small and informal eateries can compete on the characteristics the group values.

• Temporary location sharing expires with the outing.

2 Scope

2 1 Version 1 Scope

Capability

Included behavior

Venue types

Restaurants, cafes, food stalls, casual eateries, and curated alley venues

Location entry

Manual addresses or map pins entered by the representative; self-shared locations from temporary members

Center calculation

Equal-weight geometric median with a manual center override

Radius

Preset and custom search radii around the selected center

Preference input

Natural language, with optional separation by participant

Preference confirmation

Editable structured summary before recommendation generation

Recommendation

Three to five ranked venues with scores, confidence, evidence, and tradeoffs

Temporary membership

Signed-in users join an outing by link or code

Map handoff

Open the selected destination in Google Maps

Administration

Basic venue creation, editing, deduplication, and confidence management

2 2 Deferred Scope

• Permanent friend relationships, friend discovery, and social graphs

• Detailed voting rules, threaded discussion, reactions, and moderation design

• Opening-hours filtering, reservations, ordering, or payment

• Live traffic and public-transport optimization

• Personal preference learning across multiple outings

• Automated public contribution of new venues without review

• Expansion to entertainment, travel, shopping, or other outing categories

2 3 Explicit Boundary

The selected radius describes the venue search area around the calculated center. It does not promise that every participant will travel less than that radius. The interface must call it the search radius and show each participant’s distance to the center so the representative understands the consequence of the choice.

3 Users and Participation Modes

3 1 Roles

Role

Responsibilities

Permissions

Representative

Creates the outing, supplies or collects inputs, confirms the center and radius, starts recommendation generation

Manage outing settings, edit submitted group information, request recommendations, confirm the selected venue

Temporary member

Joins with a user ID, shares a location, submits preferences, and participates in group actions

View the outing, manage own information, view recommendations, and later vote or discuss

Venue curator

Maintains first-party venue data and resolves duplicates

Create, edit, verify, merge, archive, and mark data confidence

System administrator

Maintains policy, access, and operational controls

Manage users, configuration, incidents, and audit access

3 2 Representative Mode

One person enters all available starting locations and brings the group’s preference discussion into the application. Participant accounts are unnecessary for calculation. If the representative labels statements by person, the system can calculate individual satisfaction. If the input is only a group summary, the system produces a group-level preference score and states that individual fairness could not be measured.

3 3 Temporary Connected Mode

The representative creates an outing and shares a short-lived link or code. Signed-in users join the outing through a temporary membership record. Each member can share a current location or manually chosen starting point and submit preferences. Membership authorizes group-only features and expires without creating a permanent friendship.

4 Product Flow

1. Create an outing and choose representative or temporary connected participation.

2. Collect participant locations through address entry, map pins, or member location sharing.

3. Convert addresses to coordinates and let the representative correct ambiguous results.

4. Calculate the geometric median and show participant distances to that point.

5. Let the representative accept or drag the center and select the search radius.

6. Collect natural language wishes and identify statements by person when possible.

7. Parse the discussion into required constraints and weighted preferences.

8. Show the extracted interpretation for correction and approval.

9. Retrieve active venues inside the search circle and apply required constraints.

10. Calculate individual satisfaction, group satisfaction, and evidence confidence.

11. Show three to five recommendations with reasons, compromises, and unknown information.

12. Allow connected members to proceed into the later voting and discussion stage.

13. Confirm one venue and open it in Google Maps for directions or navigation.

14. Expire temporary location data and membership according to retention rules.

5 Functional Requirements

ID

Requirement

Priority

FR 01

Create an outing with a unique, unguessable identifier

Required

FR 02

Add participant locations manually or through temporary member submissions

Required

FR 03

Resolve and confirm address coordinates

Required

FR 04

Calculate and display the geometric median

Required

FR 05

Allow the representative to adjust the center and select a radius

Required

FR 06

Collect free-text preferences with participant attribution where available

Required

FR 07

Return structured preferences using a versioned schema

Required

FR 08

Allow users to correct the interpreted preferences

Required

FR 09

Retrieve venues within the selected circle

Required

FR 10

Reject venues that fail confirmed required constraints

Required

FR 11

Calculate repeatable individual and group preference scores

Required

FR 12

Show evidence confidence and missing information

Required

FR 13

Open the final venue in Google Maps

Required

FR 14

Restrict group actions to current temporary members

Required

FR 15

Record recommendation inputs, model version, schema version, and score breakdown

Required

FR 16

Support later voting and discussion without changing the matching data model

Planned

6 Location Determination

6 1 Input Normalization

Every supplied address, map pin, or shared device location becomes a participant-location record with latitude, longitude, source, capture time, and status. Both participation modes use this same record, which keeps the calculation independent of how the information arrived.

Field

Purpose

participant id

Links the point to a temporary member or representative-created placeholder

latitude and longitude

Coordinates used by the center algorithm and venue query

source

Manual address, map pin, device location, or imported saved place

accuracy

Reported device accuracy or a confidence class for geocoded addresses

captured at

Supports freshness and expiry

display label

Human-readable neighborhood or address shown for confirmation

status

Pending confirmation, confirmed, replaced, or expired

6 2 Geometric Median

The automatic center minimizes the sum of distances from the center to all participant locations. This is the geometric median. It is more resistant to one distant participant than a latitude and longitude average, which makes it suitable for the agreed case where four people may be clustered and one person is far away.

center = arg min over x of the sum of distance from x to every participant location

The implementation should project nearby latitude and longitude values into a local metric coordinate system, run Weiszfeld’s iterative algorithm, and convert the result back to latitude and longitude. Stop when the center moves by less than one metre or when the configured iteration limit is reached. Handle duplicate points and the case where an iteration lands exactly on a participant location.

6 3 Search Circle

After the center is calculated, the representative selects a preset radius such as 1, 3, 5, or 10 kilometres, or enters a custom value within the product’s configured limit. The representative may drag the center before confirming it. Once confirmed, the circle becomes the location eligibility rule.

venue is eligible by location when distance from venue to selected center is less than or equal to search radius

The database should perform this query with a geospatial index. In PostgreSQL with PostGIS, a geography-based distance query avoids manual longitude scaling and supports indexed radius searches. Location contributes no additional points after this filter.

6 4 Information Shown to the Representative

• Calculated center and whether it has been manually adjusted

• Selected search radius and estimated number of eligible venues

• Straight-line distance from each participant to the center

• Warnings for unconfirmed or low-confidence addresses

• A clear option to edit a location, remove it from this calculation, or recalculate

6 5 Location Edge Cases

Case

Expected behavior

One location

Use the location as the center

Two locations

Use the midpoint; allow manual adjustment

Duplicate locations

Retain each participant record but avoid numerical division by zero

One distant participant

Geometric median remains influenced by all members but resists large displacement

Ambiguous address

Require map confirmation before recommendation generation

No venues in circle

Offer a larger radius or a manual center change; do not silently expand

Too many venues

Keep the circle fixed and use database prefilters before detailed scoring

Location changes

Recalculate only after the representative accepts the updated point

7 Preference Interpretation

7 1 Input Model

The application accepts a pasted discussion, a representative’s summary, or separate member submissions. Statements should be attributed to a person whenever the source provides that information. Attribution enables fairness scoring; unattributed statements become group-level preferences.

7 2 Preference Schema

Field

Meaning

Example

subject

Person or group that expressed the preference

member 3

criterion

Canonical attribute name

price per person

operator

Desired comparison

less than or equal

value

Normalized target

15 USD

polarity

Want, avoid, indifferent, or unknown

want

strength

Required, strong, normal, or optional

strong

source text

Exact short evidence from the submitted discussion

somewhere quiet

parse confidence

Model confidence in the interpretation

0.88

confirmation

Unreviewed, accepted, edited, or rejected

accepted

7 3 Preference Strength

Level

Typical language

Scoring treatment

Required

must, cannot, allergic, strict maximum

Venue must pass; unknown evidence does not count as a pass

Strong

really want, strongly prefer, important

Weight 5

Normal

prefer, would like

Weight 3

Optional

nice to have, if possible

Weight 1

Indifferent

do not mind, anything is fine

No positive or negative weight

7 4 Controlled Preference Vocabulary

The first version should normalize common wishes into a controlled vocabulary. Free text remains attached as evidence, but ranking depends on canonical fields so that the same statement produces the same comparison across venues.

Category

Example values

Food

Cuisine, specific dish, spicy level, traditional, healthy, filling, light

Money

Price per person, price level, strict maximum, value for money

Diet

Vegetarian, vegan, halal, kosher, allergies, ingredient exclusions

Atmosphere

Quiet, lively, casual, intimate, scenic, local, modern

Format

Street stall, table service, buffet, takeaway, shared plates

Group fit

Seating capacity, child suitability, conversation suitability, accessibility

Occasion

Quick meal, long conversation, date, celebration, business meal

Quality signals

Rating or popularity only when the group explicitly requests them

7 5 Confirmation Experience

Before scoring, the representative sees a compact summary grouped by participant. Required constraints appear first. The interface highlights low-confidence interpretations and possible contradictions. The representative can change the value or strength, remove a preference, assign a statement to another member, or approve the whole interpretation. The approved structure becomes immutable input to that recommendation run.

8 Venue Eligibility and Ranking

8 1 Ranking Stages

1. Filter active venues to the confirmed search circle.

2. Apply confirmed required constraints. A required constraint with missing evidence fails conservatively unless the representative overrides it.

3. Calculate a match value from zero to one for every soft preference.

4. Calculate an individual satisfaction score for each identified participant.

5. Combine individual scores into the group score.

6. Use evidence confidence and data completeness to break close ties.

7. Select a diverse shortlist so near-duplicate venues do not occupy every recommendation slot.

8. Generate explanations from the stored score breakdown and evidence.

8 2 Match Functions

Data type

Match function

Boolean

One for a confirmed match and zero for a contradiction

Category

Exact or parent-child match in a controlled taxonomy

Set

Overlap between requested and available tags, with required exclusions applied first

Numeric range

One inside the desired range, then a configured decline outside it

Ordinal

Distance between levels such as quiet, moderate, and lively

Semantic description

Similarity between normalized preference text and evidence-backed venue tags

Unknown

Neutral for soft scoring and clearly marked; insufficient for a required constraint

8 3 Individual Score

Each soft preference receives a weight from its confirmed strength. The individual score is the weighted average of the preference matches, expressed from zero to one hundred. Indifferent statements carry no weight.

person score = 100 multiplied by sum of weight times match divided by sum of weights

8 4 Group Score

The recommended default gives sixty-five percent of the score to average satisfaction and thirty-five percent to the lowest individual satisfaction. This rewards broad appeal while making a badly served member visible in the ranking. The weights should be configuration values and must be recorded with each recommendation run.

group score = 0.65 times average person score plus 0.35 times lowest person score

When preferences are supplied only as an unattributed group summary, calculate a weighted group preference score and label the fairness component unavailable. Do not invent five individual scores from a collective paragraph.

8 5 Confidence and Missing Data

Preference score and evidence confidence are separate values. Confidence reflects how much of the score is supported by current venue evidence. Unknown soft attributes receive a neutral match and reduce confidence. A venue with a slightly lower score but much stronger evidence may win a tie, but confidence must not secretly replace the preference formula.

8 6 Tie Breaking

1. Higher confirmed preference score

2. Higher evidence coverage and confidence

3. Higher lowest-person score

4. Greater difference from already selected shortlist items

5. Stable venue identifier as the final deterministic tie-breaker

8 7 Ratings and Popularity

General star ratings, review count, and popularity affect the result only when the group expresses that preference or when the product later adopts a clearly disclosed minimum quality policy. This prevents highly reviewed chains from automatically outranking less documented alley venues.

9 Recommendation Experience

9 1 Shortlist

The result screen should show three to five venues. Each card contains the venue name, category, location relative to the selected center, group score, evidence confidence, two or three principal reasons, one relevant compromise or unknown, and a link to the detailed score breakdown.

Displayed element

Reason

Group match

Provides a quick ranking signal

Member score range

Shows whether the recommendation is balanced

Matched wishes

Connects the result to the submitted discussion

Compromises

Makes weak matches and conflicts visible

Evidence confidence

Separates strong venue knowledge from uncertain inference

Unknown fields

Prevents the interface from pretending missing data is known

Map action

Lets the user inspect the destination and proceed when selected

9 2 Explanation Rules

• Every reason must trace to an approved preference and stored venue evidence.

• The explanation must identify uncertainty when an attribute is inferred or unknown.

• The interface must not claim that a venue is open in Version 1.

• The explanation should state meaningful tradeoffs rather than list every criterion.

• A user can open the detailed breakdown and see the calculated contributions.

9 3 Final Map Handoff

After the group selects a venue, the application creates a Google Maps URL for that destination. Google documents that Maps URLs can open search, directions, or navigation across platforms and that a Place ID gives the strongest link to a specific establishment. Maps URLs do not require an API key. [1] For a curated alley venue without a reliable Place ID, use confirmed coordinates and include the first-party entrance note in the app.

10 Temporary Group Collaboration

10 1 Membership

An outing has an owner and a set of temporary membership records. A member joins through an unguessable link or short code plus authentication. Membership grants access only to that outing and does not create a permanent friend relationship.

10 2 Suggested Lifecycle

State

Meaning

Allowed actions

Draft

Representative is preparing the outing

Add locations and preferences

Collecting

Members are joining and submitting

Submit and edit own information

Ready

Required inputs are confirmed

Representative can generate recommendations

Shortlisted

Recommendations exist

View, share, and enter the later decision stage

Selected

One venue is confirmed

Open map and view final decision

Expired

Temporary access and location data have ended

Limited historical summary according to policy

10 3 Expiry Recommendation

A practical default is to expire precise participant locations twenty-four hours after selection, or seven days after the last activity when no venue is selected. Temporary membership can expire with the outing. The product may retain a minimal non-location history for a signed-in user if the user expects to see past outings and the retention policy states this clearly.

10 4 Later Voting and Discussion

The data model should reserve recommendation comments, votes, and a selected venue, but the product rules for voting and discussion remain a later design decision. Only current outing members can read or create these records. The ranking result remains a recommendation and does not automatically become the group’s final choice.

11 Hybrid Venue Database

11 1 Data Strategy

The venue database combines externally sourced place identity and map information with first-party curated characteristics. External data helps identify established venues. First-party data provides the detail needed to represent small eateries and subjective qualities that ordinary listings may omit.

11 2 Canonical Venue Record

Field group

Representative fields

Identity

Internal venue ID, display name, aliases, status, external Place ID

Location

Coordinates, formatted address, neighborhood, entrance note, landmark

Food

Cuisine taxonomy, dishes, dietary options, ingredients, spice level

Price

Price level, expected minimum and maximum spend, currency

Experience

Atmosphere tags, service style, seating, group suitability, occasion tags

Evidence

Source, confidence, observed date, reviewer, and supporting note for each attribute

Operations

Created time, updated time, merge history, verification status, archival status

11 3 Alley Venue Support

A small venue may have no reliable external listing. The curator must be able to create an internal venue with an exact pin, local-language name, aliases, nearby landmark, entrance instruction, and verification status. The app should distinguish the venue pin from the alley entrance when those points differ.

11 4 Attribute Evidence

Store evidence at the attribute level. Noise level may come from a recent curator visit, while price may come from a menu and cuisine from the venue owner. A single confidence score on the whole venue cannot represent these differences. Each scored attribute should include source type, confidence, observed time, and optional supporting text.

11 5 Deduplication

• Use an exact external Place ID match when available.

• Otherwise compare normalized name, coordinates, phone number, and address tokens.

• Send uncertain matches to a curator instead of merging automatically.

• Preserve aliases and source references when records are merged.

• Keep a redirect from retired internal venue IDs to the surviving record.

11 6 External Data Boundary

The implementation must verify the chosen provider’s current storage, display, attribution, and refresh requirements before importing external place data. The owned database should store first-party facts and provider identifiers according to the applicable terms, rather than assuming every field returned by an external service can be retained indefinitely.

12 Data Model

Entity

Key relationships and purpose

User

Authenticated identity for representatives, temporary members, and curators

Outing

Owner, lifecycle state, chosen center, radius, selected venue, expiry

Outing member

Temporary user-to-outing membership, role, joined time, expiry

Participant

A person included in calculation; may link to a user or remain a representative-created placeholder

Participant location

Coordinates, source, confirmation, accuracy, timestamps, expiry

Preference submission

Original text, author, participant attribution, submission time

Parsed preference

Canonical criterion, value, strength, evidence text, confidence, confirmation

Venue

Canonical identity, coordinates, descriptive fields, status

Venue attribute

Normalized value plus source, confidence, and observation date

Recommendation run

Frozen inputs, algorithm and model versions, timing, center, radius

Venue result

Eligibility outcome, score, confidence, rank, breakdown, explanation

Vote and comment

Reserved for current members in the later decision stage

Audit event

Security and administrative activity without unnecessary preference or location contents

12 1 Data Versioning

Every recommendation run should retain the approved preference structure, venue record versions, scoring configuration, location center, search radius, model identifier, prompt version, and schema version. This makes a result explainable after models or venue data change. Exact participant coordinates should follow the shorter location-retention policy rather than being retained merely for reproducibility.

13 System Architecture

13 1 Recommended Initial Stack

Layer

Recommended choice

Reason

Client

Mobile-first responsive web application using React and TypeScript

One codebase supports representative and member flows and can later become a progressive web app

Application server

TypeScript service in a modular monolith

Simpler deployment while maintaining clear location, preference, venue, and outing modules

Database

PostgreSQL with PostGIS

Relational integrity plus indexed geographic radius queries

Live updates

Server-sent events or WebSockets

Notify connected members when submissions or state change

Language model

Provider with schema-constrained structured output

Reliable preference extraction and evidence-based explanations

Maps

Geocoding and place identity as needed, plus Google Maps URLs for final handoff

Coordinates support calculation while the final route remains in Google Maps

Background work

Database-backed jobs initially

Handles parsing, enrichment, and retry without adding infrastructure too early

Observability

Structured logs, traces, metrics, and recommendation audit records

Supports diagnosis of slow or incorrect results

13 2 Component Responsibilities

Component

Responsibility

Outing service

Lifecycle, ownership, temporary membership, state transitions, and expiry

Location service

Address resolution, confirmation, geometric median, radius validation, and spatial candidate retrieval

Preference service

Submission storage, model invocation, schema validation, user corrections, and versioning

Venue service

Canonical records, attributes, provenance, deduplication, and curator workflow

Ranking service

Hard constraints, match functions, individual scores, group aggregation, ties, and breakdowns

Explanation service

Natural language summaries generated only from approved preferences and score evidence

Map integration

Provider identifiers, map URLs, and destination handoff

13 3 Request Sequence

1. The client freezes the current center, radius, participants, and approved preferences into a recommendation request.

2. The location service retrieves venue IDs inside the circle.

3. The venue service loads normalized attributes and their evidence.

4. The ranking service applies hard constraints and calculates score breakdowns.

5. The explanation service produces short text from the highest-ranked breakdowns.

6. The server stores the run and returns a stable ranked response to all current outing members.

13 4 Performance Approach

Run the spatial query and deterministic scoring before explanation generation. Limit the language model’s explanation input to the top candidates and their score evidence. Cache approved preference parsing and reuse it until a user edits the source or structured result. Paginate venue administration queries and index venue geography, normalized tags, outing membership, and expiry timestamps.

14 Application Interfaces

14 1 Proposed Endpoints

Method and path

Purpose

POST /outings

Create an outing

POST /outings/{id}/join

Join through a temporary invitation

POST /outings/{id}/participants

Add a representative-created participant

PUT /outings/{id}/participants/{id}/location

Create or replace a participant location

POST /outings/{id}/center/calculate

Calculate the geometric median

PUT /outings/{id}/search-area

Confirm or adjust the center and radius

POST /outings/{id}/preference-submissions

Submit natural language preferences

POST /outings/{id}/preferences/parse

Create a structured interpretation

PUT /outings/{id}/preferences/{id}

Confirm, edit, or reject an interpreted preference

POST /outings/{id}/recommendations

Generate a frozen recommendation run

GET /outings/{id}/recommendations/{runId}

Read results and score breakdowns

PUT /outings/{id}/selection

Confirm the selected venue

GET /venues/{id}/map-link

Return a Google Maps destination URL

14 2 Authorization Rules

• Only the outing owner can change the confirmed center, radius, or selected venue in Version 1.

• A connected member can read only outings where the membership is current.

• A member can change only their own location and submissions unless the owner has explicit edit authority.

• Recommendation generation requires a confirmed search area and approved preference structure.

• Curator endpoints use a separate role and must never expose participant locations.

15 Language Model Contract

15 1 Allowed Responsibilities

• Extract preferences, constraints, polarity, strength, subject, and source evidence into the approved schema.

• Normalize food and experience language to the controlled vocabulary.

• Identify contradictions and ambiguous statements for user review.

• Generate explanations from deterministic score breakdowns and venue evidence.

15 2 Prohibited Responsibilities

• Invent venue attributes that are absent from stored evidence.

• Choose venues directly from an unrestricted database dump.

• Override the confirmed search circle or required constraints.

• Change scoring weights without a recorded configuration change.

• Claim current opening status in Version 1.

15 3 Structured Output Validation

Validate model output against a versioned JSON schema. Reject unknown criteria, malformed units, values outside permitted ranges, unsupported participant IDs, or evidence text absent from the source submission. Retry with a repair instruction only for structural failures. Route persistent failures to manual preference entry.

15 4 Prompt Injection Boundary

Treat group discussion and venue descriptions as untrusted text. The model receives instructions that their contents are evidence to classify, not commands to follow. The application supplies candidate attributes in structured fields, validates all output, and never allows model text to call tools or write directly to the database.

16 Privacy and Security

16 1 Location Privacy

• Ask for location only within an active outing and explain its use before collection.

• Allow a manually chosen starting point when a member does not want to share device location.

• Show other members a neighborhood or distance summary instead of an exact address by default.

• Encrypt location data in transit and at rest and restrict server access by outing membership.

• Delete or irreversibly detach precise location coordinates at the configured expiry time.

• Avoid storing exact location values in ordinary application logs or analytics events.

16 2 Invitation Security

Invitation identifiers must be unguessable, revocable, time-limited, and bound to a single outing. Short display codes should be backed by rate limits and authentication. Removing a member must revoke their access immediately. The owner should see the current membership list before recommendation generation.

16 3 Preference Privacy

Dietary restrictions and accessibility needs can reveal sensitive personal information. Collect only what the recommendation requires, show who can view it, and avoid reusing it across outings until the product offers an explicit saved-preference feature with separate consent and controls.

16 4 Operational Security

• Role-based administration for venue curation and system operations

• Rate limits for invitations, geocoding, preference parsing, and recommendation creation

• Secrets stored outside source control and rotated through the deployment environment

• Audit records for administrative venue changes and access-control events

• Dependency scanning, database backups, restore exercises, and incident procedures

17 Quality and Evaluation

17 1 Evaluation Layers

Layer

What to measure

Example release target

Location

Correct center, radius inclusion, and manual override behavior

All geometric fixtures and boundary cases pass

Preference parsing

Criterion, value, polarity, strength, subject, and evidence accuracy

At least 90 percent field accuracy on the reviewed pilot set

Hard constraints

No confirmed contradiction reaches the shortlist

100 percent on the safety and dietary test set

Ranking

Human pairwise agreement and top-three usefulness

At least 75 percent agreement during pilot review

Fairness

Distribution of lowest-member score and user-reported exclusion

No unexplained member score below the configured warning threshold

Venue data

Coverage, evidence confidence, duplicates, and stale attributes

Critical fields present for at least 85 percent of pilot-area venues

Experience

Time to shortlist and successful map handoff

Median shortlist time under two minutes of user interaction

Reliability

Recommendation latency and failure rate

Proposed p95 under eight seconds and error rate below one percent

These numbers are proposed pilot gates, not observed performance. The team should adjust them after measuring real data volume, model latency, and user behavior.

17 2 Test Dataset

Build a reviewed evaluation set containing real and synthetic group discussions, attributed and unattributed submissions, negation, indifference, conflicting requirements, mixed languages, slang, budget units, food allergies, and ambiguous pronouns. Pair each case with approved structured preferences and a small set of venue records so parsing, filtering, scoring, and explanations can be tested independently.

17 3 Product Metrics

• Percentage of created outings that reach a recommendation shortlist

• Time from first input to shortlist and from shortlist to map handoff

• Percentage of recommendations accepted without regenerating

• Correction rate for center, radius, and parsed preferences

• Top recommendation selection rate and top-three selection rate

• Lowest-member satisfaction at the selected venue

• Venue data fields most often reported as unknown or incorrect

• Temporary membership join and expiry success rates

18 Delivery Plan

18 1 Product Increments

Increment

Deliverable

Exit condition

Foundation

Venue schema, location records, PostGIS query, geometric median, scoring library

Deterministic tests pass on geographic and scoring fixtures

Representative prototype

Create outing, enter five locations, choose radius, paste preferences, review parsing, receive shortlist

A representative can complete the whole flow with seeded venues

Temporary groups

Authentication, join link, member locations and preferences, live state updates, expiry

Five users can complete one outing with enforced access control

Curation

Hybrid venue import, manual alley venue entry, evidence fields, deduplication

Pilot area has enough verified venues to produce useful shortlists

Pilot

Instrumentation, evaluation workflow, user feedback, operational dashboard

Pilot gates are measured and critical defects are resolved

Decision features

Voting, discussion, selection rules, notifications

Rules are separately defined and validated with users

18 2 Indicative Schedule

For a small team of two or three engineers with product and design support, a representative-only prototype may take four to six weeks after the venue schema and pilot data are available. Temporary connected groups, curation tools, and pilot hardening may add another four to eight weeks. Data collection can become the critical path, so it should start before the interface is complete. These ranges are planning assumptions and must be revised after technical discovery.

18 3 Initial Backlog

Priority

Work

P0

Venue and attribute schema; participant locations; geometric median; radius query; preference schema; deterministic scoring; representative flow; map handoff

P1

Temporary membership; member submissions; live updates; venue curation; deduplication; recommendation audit; expiry jobs

P2

Vote and discussion; permanent saved groups; travel-time center options; opening-hours filter; preference learning

19 Risks and Controls

Risk

Why it matters

Control

Sparse venue attributes

The model cannot match quiet, local, or group-friendly preferences without evidence

Begin with one pilot area, curate high-value fields, show unknowns, and measure field coverage

Preference misinterpretation

Negation, jokes, and vague language can reverse meaning

Show editable extraction, preserve source evidence, and track correction rates

Outlier dissatisfaction

The geometric median favors the cluster by design

Show every distance, allow manual center movement, and keep the group in control

False precision

A numeric score can appear more certain than the data

Display evidence confidence, unknown attributes, and score breakdowns

Small venue disadvantage

Missing external reviews can suppress alley eateries

Exclude ratings unless requested and build first-party evidence

Location exposure

Starting locations can reveal homes or routines

Use temporary access, reduced display precision, strict authorization, and expiry

Provider dependency

Terms, prices, quotas, or product behavior can change

Keep provider adapters, monitor usage, retain first-party canonical data, and review current terms before launch

Slow recommendations

Large candidate sets and repeated model calls harm the social moment

Spatial prefilter, deterministic scoring, cached parsing, and explanations only for top candidates

Manipulated descriptions

Venue text can contain misleading claims or instructions

Treat venue text as untrusted evidence, validate model output, and use curator review

20 Acceptance Criteria

• A representative can create an outing and provide at least one participant location.

• Five participant locations produce a reproducible geometric median within the agreed numerical tolerance.

• The representative can see participant distances, move the center, and choose a search radius.

• Every candidate venue returned by the location query is inside the confirmed circle.

• Location does not change ranking scores after eligibility is established.

• The language model returns schema-valid preferences linked to source evidence.

• The representative can correct every parsed field before scoring.

• A venue that contradicts a confirmed required constraint does not enter the shortlist.

• Individual scores and the configured group formula reproduce the displayed ranking.

• Unknown venue data is visible and does not become a fabricated match.

• Connected users outside the outing cannot read its locations, preferences, or recommendations.

• A selected venue opens as the intended destination in Google Maps.

• Expired precise locations are inaccessible through ordinary product and administrative interfaces.

• Each recommendation run records enough non-expired configuration data to explain its score.

21 Open Product Decisions

The following choices remain open and should be decided through prototype testing. They do not block the location, parsing, and ranking foundation.

Decision

Recommended starting point

Pilot geography

One dense city area with a manageable curation boundary

Default radius

Three kilometres in dense urban areas, adjustable before every run

Custom radius limit

Set by pilot geography and database coverage

Group formula

Sixty-five percent average satisfaction and thirty-five percent lowest satisfaction

Shortlist size

Three primary recommendations with up to two alternatives

Required unknowns

Conservative failure with a representative override

Member location visibility

Neighborhood and distance only; exact point visible to its owner and the location service

Session expiry

Twenty-four hours after selection or seven days after inactivity

Voting and discussion

Define after observing how groups use the shortlist

Languages

Choose from the pilot population and include mixed-language evaluation cases

Appendix A Example Structured Data

{

  "outing_id": "outing_123",

  "search_area": {

    "center_source": "geometric_median",

    "center": {"latitude": 10.7769, "longitude": 106.7009},

    "radius_km": 5,

    "confirmed_by": "user_1"

  },

  "participants": [

    {

      "participant_id": "participant_1",

      "user_id": "user_1",

      "location_status": "confirmed",

      "preferences": [

        {

          "criterion": "cuisine",

          "operator": "includes",

          "value": ["vietnamese"],

          "polarity": "want",

          "strength": "strong",

          "source_text": "I really want Vietnamese food",

          "parse_confidence": 0.96,

          "confirmation": "accepted"

        }

      ]

    }

  ]

}

Appendix B Scoring Example

Assume five people have approved preferences and every candidate already passed the search-circle and required-constraint filters. The table below illustrates the fairness effect of the default group formula.

Venue

Average score

Lowest score

Group score

Result

Alley Noodles

91

35

71.4

High enthusiasm but one member is poorly served

Garden Kitchen

82

70

77.8

Highest group score because satisfaction is balanced

Central Bistro

76

73

75.0

Consistent but less preferred overall

Calculation for Garden Kitchen: 0.65 multiplied by 82 plus 0.35 multiplied by 70 equals 77.8. The score is fully reproducible from the approved preferences, venue evidence, and stored weight configuration.

References

The product design in this report is based on the agreed application rules. The following primary technical references support the proposed Google Maps handoff and address-resolution design. Accessed 12 September 2026.

1. Google Maps URLs Get Started. Official documentation

2. Google Maps Platform Geocoding API Overview. Official documentation

3. Google Maps Platform Place IDs. Official documentation