# 🐟 KoiPilot — Guided by Blush ,Your Co-Browsing Koi
**Shared 21 · wHACKiest 2026 · Track 2 — Beyond the Browser**
Prarthana had the instructions open during a Google Cloud Arcade lab and still couldn’t find the button she needed. Blush is our idea for that moment. Tell her what you want to do, and a tiny pink pixel fish swims over to the next control. You make the click. Blush checks what happened and remembers the steps once the task succeeds.
**Project stage:** Hackathon prototype in development. We tested the starter’s local shop page and mock API response. The full Chrome-to-AWS flow, voice, and cross-profile replay are planned demo milestones. Our walkthrough video illustrates the intended experience.
## What makes a route worth remembering?
Imagine asking Blush to help create a GitHub repository. You enter a name, click **Create**, and GitHub says the name is taken. Blush should stay beside the name field. The completed-run counter should still read **0**.
Once the new repository page shows the owner and name you chose, Blush can count the run and save the route. The next person can follow those steps in a fresh browser profile and pick their own name. A successful replay should take **zero new planning calls**.
## What we’re building
| Feature | What you’ll see |
|---|---|
| Type or speak a goal | Open Blush and type a request or tap the mic. Typing stays available if the microphone is blocked. |
| Follow the fish | Blush circles a live control and explains the step in a speech bubble. You keep the mouse and keyboard. |
| Check the result | An error keeps the current step open. Each supported task has a specific result the extension can check on screen. |
| Reuse a verified route | Blush looks for a route that matches the website, task, and starting screen. A badge shows how many runs reached the finish line. |
| Hear a hint | An optional spoken hint gives a landmark such as “Under Account, choose Returns.” You can mute it or ask to hear it again. |
The page reader is designed for use across websites. For the prototype, we’ll test two finish lines: **creating a GitHub repository** and **finding a public store’s return policy**. For the store task, the policy section itself must be visible. Following pasted tutorials and repairing a route after a site changes are stretch goals.
## How it works
1. The Chrome extension reads relevant visible buttons, links, and labelled fields. It gives each one a temporary ID for the current screen.
2. Through API Gateway, Lambda asks DynamoDB for a matching verified route. When it needs a new step, it asks Claude on Amazon Bedrock to choose among the visible controls.
3. The extension checks the returned ID, moves the fish, and displays the hint. With sound enabled, ElevenLabs reads the hint aloud. S3 caches repeated audio.
4. The user acts. The extension checks the expected result locally. After the finish line is reached, Lambda records that run once, even if the browser retries the request.
## Run the local starter in VS Code
You’ll need **desktop Chrome** and **Node.js LTS**. The local starter uses Node’s built-in modules and requires no cloud keys.
1. Open the project folder in VS Code. The starter uses four files: `fixtures/store.html`, `backend/mock.mjs`, `extension/manifest.json`, and `extension/background.js`. If you’re setting up an empty repository, copy those four starter blocks from section 3 of the team’s **Blush Build Guide** first.
2. Open **Terminal → New Terminal** at the repository root and run:
   ```sh
   node backend/mock.mjs
   ```
3. Leave the terminal running and open [the local demo shop](http://127.0.0.1:8787/shop) in Chrome.
4. In another tab, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the **extension** folder.
5. Return to the shop and click the Blush toolbar icon. The **Returns** link should get a plum outline. Click it yourself to reach the policy heading.
The outline is the first milestone. It proves that the extension can read a control, ask a backend which one to highlight, and find it again on the page. After changing extension code, reload the extension and refresh the shop tab.
## Repository layout
| Path | Purpose |
|---|---|
| `extension/manifest.json`, `background.js`, `config.js` | Chrome permissions, tab sessions, and backend URL |
| `extension/content.js`, `page-reader.js`, `verifiers.js` | Read controls, run guide steps, and verify outcomes |
| `extension/overlay.js`, `overlay.css`, `assets/blush.png` | Draw the fish, ring, and speech bubble |
| `extension/panel.html`, `panel.js`, `voice-input.js`, `mic-setup.html`, `mic-setup.js` | Goal entry, mic setup, repeat, mute, and stop |
| `backend/mock.mjs`, `fixtures/store.html` | Local starter server and test page |
| `backend/index.mjs`, `planner.mjs`, `routes.mjs`, `voice.mjs` | Lambda router, Bedrock planner, DynamoDB route memory, and speech output |
| `docs/api-contract.md`, `docs/demo.md` | Shared API examples and rehearsal checklist |
This is the planned layout. In grouped rows, filenames without a directory share the preceding directory.
## Cloud API
| Method and route | Purpose |
|---|---|
| `GET /health` | Confirm the deployed backend is reachable |
| `POST /path` | Look up a verified route for the current site, task, and starting screen |
| `POST /next` | Return a visible control ID, a hint, and an expected check for a new step |
| `POST /complete` | Record a verified run using its unique run ID |
| `POST /voice` | Return audio for an approved guide hint |
The local starter implements the shop page and a fixture version of `POST /next`. For the cloud build, set `API_BASE` in `extension/config.js` to the API Gateway invoke URL. Configure Lambda with `ROUTES_TABLE`, `AUDIO_BUCKET`, `BEDROCK_MODEL_ID`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_KEY_PARAM`, and `DEMO_TOKEN`. Lambda uses its AWS execution role. Store the ElevenLabs key as a SecureString in AWS Systems Manager Parameter Store. Keep keys and demo tokens out of Git and the extension source.
## Privacy and user control
The shared route stores which control to use, what to check, and the order of the steps. Website form values stay out of shared routes and planner requests. The extension compares the requested GitHub owner and name locally. Goals and relevant control labels can go to the planner. Chrome may use an online service for speech recognition, and ElevenLabs receives the hint text when spoken guidance is enabled. The user makes every click and chooses every form value.
## Team
| Member | Build responsibilities |
|---|---|
| **Prarthana S.** | Chrome extension, page reader, fish animation, microphone input, and local finish-line checks |
| **Surabhi** | AWS API, Bedrock planning, DynamoDB route memory, ElevenLabs output, and S3 audio caching |
Our first shared test is small: Prarthana sends the controls from a page, Surabhi returns one ID and a hint, and Blush swims to that control. Then we test a failed attempt, a verified success, and replay in a second browser before adding voice and stretch features.
