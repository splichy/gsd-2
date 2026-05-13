import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { showNextAction } from "../shared/tui.js";
const SKILL_CATALOG = [
  // ── Swift (language-level — any Swift project) ────────────────────────────
  {
    label: "SwiftUI",
    description: "SwiftUI layout, navigation, animations, gestures, Liquid Glass",
    repo: "dpearson2699/swift-ios-skills",
    skills: [
      "swiftui-animation",
      "swiftui-gestures",
      "swiftui-layout-components",
      "swiftui-liquid-glass",
      "swiftui-navigation",
      "swiftui-patterns",
      "swiftui-performance",
      "swiftui-uikit-interop"
    ],
    matchLanguages: ["swift"],
    matchFiles: ["Package.swift"]
  },
  {
    label: "Swift Core",
    description: "Swift language, concurrency, Codable, Charts, Testing, SwiftData",
    repo: "dpearson2699/swift-ios-skills",
    skills: [
      "swift-codable",
      "swift-charts",
      "swift-concurrency",
      "swift-language",
      "swift-testing",
      "swiftdata"
    ],
    matchLanguages: ["swift"],
    matchFiles: ["Package.swift"]
  },
  // ── iOS (Xcode project targeting iphoneos required) ───────────────────────
  {
    label: "iOS App Frameworks",
    description: "App Intents, Widgets, StoreKit, MapKit, Live Activities, push notifications",
    repo: "dpearson2699/swift-ios-skills",
    skills: [
      "alarmkit",
      "app-clips",
      "app-intents",
      "live-activities",
      "mapkit-location",
      "photos-camera-media",
      "push-notifications",
      "storekit",
      "tipkit",
      "widgetkit"
    ],
    matchXcodePlatforms: ["iphoneos"]
  },
  {
    label: "iOS Data Frameworks",
    description: "CloudKit, HealthKit, MusicKit, WeatherKit, Contacts, Calendar",
    repo: "dpearson2699/swift-ios-skills",
    skills: [
      "cloudkit-sync",
      "contacts-framework",
      "eventkit-calendar",
      "healthkit",
      "musickit-audio",
      "passkit-wallet",
      "weatherkit"
    ],
    matchXcodePlatforms: ["iphoneos"]
  },
  {
    label: "iOS AI & ML",
    description: "Core ML, Vision, on-device AI, speech recognition, NLP",
    repo: "dpearson2699/swift-ios-skills",
    skills: [
      "apple-on-device-ai",
      "coreml",
      "natural-language",
      "speech-recognition",
      "vision-framework"
    ],
    matchXcodePlatforms: ["iphoneos"]
  },
  {
    label: "iOS Engineering",
    description: "Networking, security, accessibility, localization, Instruments, App Store review",
    repo: "dpearson2699/swift-ios-skills",
    skills: [
      "app-store-review",
      "authentication",
      "background-processing",
      "debugging-instruments",
      "device-integrity",
      "ios-accessibility",
      "ios-localization",
      "ios-networking",
      "ios-security",
      "metrickit-diagnostics"
    ],
    matchXcodePlatforms: ["iphoneos"]
  },
  {
    label: "iOS Hardware",
    description: "Bluetooth, CoreMotion, NFC, PencilKit, RealityKit AR",
    repo: "dpearson2699/swift-ios-skills",
    skills: [
      "core-bluetooth",
      "core-motion",
      "core-nfc",
      "pencilkit-drawing",
      "realitykit-ar"
    ],
    matchXcodePlatforms: ["iphoneos"]
  },
  {
    label: "iOS Platform",
    description: "CallKit, EnergyKit, HomeKit, SharePlay, PermissionKit",
    repo: "dpearson2699/swift-ios-skills",
    skills: [
      "callkit-voip",
      "energykit",
      "homekit-matter",
      "permissionkit",
      "shareplay-activities"
    ],
    matchXcodePlatforms: ["iphoneos"]
  },
  // ── React / Next.js ───────────────────────────────────────────────────────
  {
    label: "React & Web Frontend",
    description: "React best practices and composition patterns",
    repo: "vercel-labs/agent-skills",
    skills: [
      "vercel-react-best-practices",
      "vercel-composition-patterns"
    ],
    matchLanguages: ["javascript/typescript"]
  },
  {
    label: "shadcn/ui",
    description: "shadcn/ui component library patterns and usage",
    repo: "shadcn/ui",
    skills: ["shadcn"],
    matchLanguages: ["javascript/typescript"]
  },
  // ── React Native ──────────────────────────────────────────────────────────
  {
    label: "React Native",
    description: "React Native and Expo best practices for performant mobile apps",
    repo: "vercel-labs/agent-skills",
    skills: ["vercel-react-native-skills"],
    matchFiles: ["metro.config.js", "metro.config.ts", "react-native.config.js"]
  },
  {
    label: "React Native Architecture",
    description: "React Native app architecture, navigation, and cross-platform design patterns",
    repo: "wshobson/agents",
    skills: ["react-native-architecture", "react-native-design"],
    matchFiles: ["metro.config.js", "metro.config.ts", "react-native.config.js"]
  },
  // ── TypeScript & JS Ecosystem (wshobson/agents — 41K combined installs) ──
  {
    label: "TypeScript & JS Development",
    description: "Advanced TypeScript types, Node.js backend, testing, and modern JS patterns",
    repo: "wshobson/agents",
    skills: [
      "typescript-advanced-types",
      "nodejs-backend-patterns",
      "javascript-testing-patterns",
      "modern-javascript-patterns"
    ],
    matchLanguages: ["javascript/typescript"]
  },
  // ── React State (wshobson/agents — 8.1K combined installs) ─────────────
  {
    label: "React State & Patterns",
    description: "State management with Zustand, Jotai, React Query, and React modernization",
    repo: "wshobson/agents",
    skills: ["react-state-management", "react-modernization"],
    matchLanguages: ["javascript/typescript"]
  },
  // ── Tailwind CSS (wshobson/agents — 22.8K installs) ───────────────────
  {
    label: "Tailwind CSS",
    description: "Tailwind v4 design system, CVA patterns, and utility-first CSS",
    repo: "wshobson/agents",
    skills: ["tailwind-design-system"],
    matchFiles: [
      "tailwind.config.js",
      "tailwind.config.ts",
      "tailwind.config.mjs",
      "tailwind.config.cjs"
    ]
  },
  // ── General Frontend ──────────────────────────────────────────────────────
  {
    label: "Frontend Design & UX",
    description: "Frontend design, accessibility, and browser automation",
    repo: "anthropics/skills",
    skills: ["frontend-design"],
    matchLanguages: ["javascript/typescript"]
  },
  // ── Angular ───────────────────────────────────────────────────────────────
  {
    label: "Angular",
    description: "Angular components, signals, forms, routing, and testing",
    repo: "analogjs/angular-skills",
    skills: [
      "angular-component",
      "angular-signals",
      "angular-forms",
      "angular-routing",
      "angular-testing"
    ],
    matchFiles: ["angular.json"]
  },
  {
    label: "Angular Migration",
    description: "Migrate from AngularJS to Angular with hybrid mode and incremental rewriting",
    repo: "wshobson/agents",
    skills: ["angular-migration"],
    matchFiles: ["angular.json"]
  },
  // ── Vue.js / Nuxt ────────────────────────────────────────────────────────
  {
    label: "Vue.js",
    description: "Vue best practices, Pinia state, Vue Router, and testing",
    repo: "vuejs-ai/skills",
    skills: [
      "vue-best-practices",
      "vue-pinia-best-practices",
      "vue-router-best-practices",
      "vue-testing-best-practices"
    ],
    matchFiles: ["nuxt.config.ts", "nuxt.config.js", "vue.config.js", "vue.config.ts", "*.vue"]
  },
  // ── Svelte / SvelteKit ────────────────────────────────────────────────────
  {
    label: "Svelte",
    description: "Svelte code patterns and SvelteKit best practices",
    repo: "sveltejs/ai-tools",
    skills: ["svelte-code-writer", "svelte-core-bestpractices"],
    matchFiles: ["svelte.config.js", "svelte.config.ts"]
  },
  // ── Next.js ───────────────────────────────────────────────────────────────
  {
    label: "Next.js",
    description: "Next.js app router, server components, and deployment patterns",
    repo: "vercel-labs/vercel-plugin",
    skills: ["nextjs"],
    matchFiles: ["next.config.js", "next.config.ts", "next.config.mjs"]
  },
  {
    label: "Next.js App Router Patterns",
    description: "Next.js 14+ App Router, React Server Components, and streaming",
    repo: "wshobson/agents",
    skills: ["nextjs-app-router-patterns"],
    matchFiles: ["next.config.js", "next.config.ts", "next.config.mjs"]
  },
  // ── Java / Spring Boot ────────────────────────────────────────────────────
  {
    label: "Java & Spring Boot",
    description: "Spring Boot best practices, DI, RESTful APIs, JPA, testing, and security",
    repo: "github/awesome-copilot",
    skills: ["java-springboot"],
    matchFiles: ["dep:spring-boot"]
  },
  // ── .NET / C# ────────────────────────────────────────────────────────────
  {
    label: ".NET & C#",
    description: ".NET best practices, design patterns, and upgrade guidance",
    repo: "github/awesome-copilot",
    skills: ["dotnet-best-practices", "dotnet-design-pattern-review"],
    matchLanguages: ["csharp"],
    matchFiles: ["*.csproj"]
  },
  {
    label: ".NET Backend Patterns",
    description: ".NET backend architecture, middleware, and production patterns",
    repo: "wshobson/agents",
    skills: ["dotnet-backend-patterns"],
    matchFiles: ["*.csproj", "*.fsproj", "*.sln"]
  },
  // ── Flutter / Dart ────────────────────────────────────────────────────────
  {
    label: "Flutter",
    description: "Flutter layouts, architecture, state management, and testing",
    repo: "flutter/skills",
    skills: [
      "flutter-building-layouts",
      "flutter-architecting-apps",
      "flutter-managing-state",
      "flutter-testing-apps"
    ],
    matchLanguages: ["dart/flutter"],
    matchFiles: ["pubspec.yaml"]
  },
  // ── PHP / Laravel ─────────────────────────────────────────────────────────
  {
    label: "PHP & Laravel",
    description: "Laravel patterns, PHP best practices, and testing",
    repo: "jeffallan/claude-skills",
    skills: ["laravel-specialist", "php-pro"],
    matchLanguages: ["php"],
    matchFiles: ["composer.json"]
  },
  // ── Django ────────────────────────────────────────────────────────────────
  {
    label: "Django",
    description: "Django expert patterns, models, views, and middleware",
    repo: "vintasoftware/django-ai-plugins",
    skills: ["django-expert"],
    matchFiles: ["manage.py"]
  },
  // ── Rust ──────────────────────────────────────────────────────────────────
  {
    label: "Rust",
    description: "Rust language patterns and best practices",
    repo: "anthropics/skills",
    skills: ["rust-best-practices"],
    matchLanguages: ["rust"],
    matchFiles: ["Cargo.toml"]
  },
  {
    label: "Rust Async Patterns",
    description: "Async Rust with Tokio, futures, and proper error handling",
    repo: "wshobson/agents",
    skills: ["rust-async-patterns"],
    matchLanguages: ["rust"],
    matchFiles: ["Cargo.toml"]
  },
  // ── Python ────────────────────────────────────────────────────────────────
  {
    label: "Python",
    description: "Python patterns and best practices",
    repo: "anthropics/skills",
    skills: ["python-best-practices"],
    matchLanguages: ["python"],
    matchFiles: ["pyproject.toml", "setup.py", "requirements.txt"]
  },
  {
    label: "Python Advanced",
    description: "Python performance, testing, async patterns, and uv package manager",
    repo: "wshobson/agents",
    skills: [
      "python-performance-optimization",
      "python-testing-patterns",
      "async-python-patterns",
      "uv-package-manager"
    ],
    matchLanguages: ["python"],
    matchFiles: ["pyproject.toml", "setup.py", "requirements.txt"]
  },
  // FastAPI — detected by scanning requirements.txt / pyproject.toml for the
  // "fastapi" dependency. Uses the "dep:fastapi" synthetic marker from detection.ts.
  {
    label: "FastAPI",
    description: "Production-ready FastAPI projects with async patterns and error handling",
    repo: "wshobson/agents",
    skills: ["fastapi-templates"],
    matchFiles: ["dep:fastapi"]
  },
  // ── Go ────────────────────────────────────────────────────────────────────
  {
    label: "Go",
    description: "Go language patterns and best practices",
    repo: "anthropics/skills",
    skills: ["go-best-practices"],
    matchLanguages: ["go"],
    matchFiles: ["go.mod"]
  },
  {
    label: "Go Concurrency Patterns",
    description: "Go concurrency with channels, worker pools, and context cancellation",
    repo: "wshobson/agents",
    skills: ["go-concurrency-patterns"],
    matchLanguages: ["go"],
    matchFiles: ["go.mod"]
  },
  // ── Database / ORM ─────────────────────────────────────────────────────────
  {
    label: "Prisma",
    description: "Prisma ORM setup, schema design, client API, and migrations",
    repo: "prisma/skills",
    skills: [
      "prisma-database-setup",
      "prisma-client-api",
      "prisma-cli"
    ],
    matchFiles: ["prisma/schema.prisma"]
  },
  {
    label: "Supabase & Postgres",
    description: "Supabase project setup, auth, Postgres best practices, and Firestore",
    repo: "supabase/agent-skills",
    skills: ["supabase-postgres-best-practices"],
    matchFiles: ["supabase/config.toml"]
  },
  {
    label: "PostgreSQL Design",
    description: "PostgreSQL table design, indexing strategies, and query optimization",
    repo: "wshobson/agents",
    skills: ["postgresql-table-design"],
    matchFiles: ["supabase/config.toml", "*.sql"]
  },
  {
    label: "SQL Optimization & Review",
    description: "Universal SQL performance optimization, security (injection prevention), and code review",
    repo: "github/awesome-copilot",
    skills: ["sql-optimization", "sql-code-review"],
    matchFiles: [
      "*.sql",
      "*.sqlite",
      "prisma/schema.prisma",
      "supabase/config.toml",
      "drizzle.config.ts",
      "drizzle.config.js"
    ]
  },
  {
    label: "Redis",
    description: "Redis development patterns and best practices",
    repo: "redis/agent-skills",
    skills: ["redis-development"],
    matchFiles: ["redis.conf"]
  },
  // ── Cloud Platforms ────────────────────────────────────────────────────────
  {
    label: "Firebase",
    description: "Firebase setup, auth, Firestore, hosting, and AI Logic",
    repo: "firebase/agent-skills",
    skills: [
      "firebase-basics",
      "firebase-auth-basics",
      "firebase-firestore-basics",
      "firebase-hosting-basics",
      "firebase-ai-logic"
    ],
    matchFiles: ["firebase.json"]
  },
  {
    label: "Azure",
    description: "Azure deployment, AI services, storage, cost optimization, and diagnostics",
    repo: "microsoft/github-copilot-for-azure",
    skills: [
      "azure-deploy",
      "azure-ai",
      "azure-storage",
      "azure-cost-optimization",
      "azure-diagnostics"
    ],
    matchFiles: ["azure-pipelines.yml"]
  },
  {
    label: "AWS",
    description: "AWS deployment, Lambda, and serverless patterns",
    repo: "awslabs/agent-plugins",
    skills: ["deploy", "aws-lambda", "aws-serverless-deployment"],
    matchFiles: ["cdk.json", "samconfig.toml", "serverless.yml", "serverless.yaml"]
  },
  // ── Container / DevOps ─────────────────────────────────────────────────────
  {
    label: "Docker",
    description: "Multi-stage Dockerfiles, layer optimization, and security hardening",
    repo: "github/awesome-copilot",
    skills: ["multi-stage-dockerfile"],
    matchFiles: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml"]
  },
  // ── Infrastructure as Code ─────────────────────────────────────────────────
  {
    label: "Terraform",
    description: "Terraform style guide, testing, and stack patterns",
    repo: "hashicorp/agent-skills",
    skills: ["terraform-style-guide", "terraform-test", "terraform-stacks"],
    matchFiles: ["main.tf"]
  },
  // ── Android (wshobson/agents — 7K installs) ────────────────────────────────
  {
    label: "Android",
    description: "Android app design following Material Design 3 guidelines",
    repo: "wshobson/agents",
    skills: ["mobile-android-design"],
    matchFiles: ["app/build.gradle", "app/build.gradle.kts"]
  },
  // ── Kubernetes (wshobson/agents — 4 skills) ────────────────────────────────
  {
    label: "Kubernetes",
    description: "K8s manifests, Helm charts, GitOps workflows, and security policies",
    repo: "wshobson/agents",
    skills: [
      "k8s-manifest-generator",
      "helm-chart-scaffolding",
      "gitops-workflow",
      "k8s-security-policies"
    ],
    matchFiles: ["Chart.yaml", "kustomization.yaml"]
  },
  // ── CI/CD (wshobson/agents — 3 skills) ─────────────────────────────────────
  {
    label: "CI/CD Automation",
    description: "Pipeline design, GitHub Actions workflows, and secrets management",
    repo: "wshobson/agents",
    skills: [
      "deployment-pipeline-design",
      "github-actions-templates",
      "secrets-management"
    ],
    matchFiles: [".github/workflows"]
  },
  // ── Blockchain / Web3 (wshobson/agents — 3 skills) ─────────────────────────
  {
    label: "Blockchain & Web3",
    description: "Solidity security, DeFi protocols, and smart contract testing",
    repo: "wshobson/agents",
    skills: ["solidity-security", "defi-protocol-templates", "web3-testing"],
    matchFiles: ["hardhat.config.js", "hardhat.config.ts", "foundry.toml"]
  },
  // ── Data Engineering (wshobson/agents — 4 skills) ──────────────────────────
  {
    label: "Data Engineering",
    description: "dbt transformations, Airflow DAGs, Spark optimization, and data quality",
    repo: "wshobson/agents",
    skills: [
      "dbt-transformation-patterns",
      "airflow-dag-patterns",
      "spark-optimization",
      "data-quality-frameworks"
    ],
    matchFiles: ["dbt_project.yml", "airflow.cfg"]
  },
  // ── Game Development — Unity (wshobson/agents) ─────────────────────────────
  {
    label: "Unity",
    description: "Unity ECS patterns for high-performance game systems",
    repo: "wshobson/agents",
    skills: ["unity-ecs-patterns"],
    matchFiles: ["ProjectSettings/ProjectVersion.txt"]
  },
  // ── Game Development — Godot (wshobson/agents) ─────────────────────────────
  {
    label: "Godot",
    description: "Godot GDScript best practices and scene composition",
    repo: "wshobson/agents",
    skills: ["godot-gdscript-patterns"],
    matchFiles: ["project.godot"]
  },
  // ── Essential (all projects) ────────────────────────────────────────────
  {
    label: "Skill Discovery",
    description: "Find and install new agent skills from the ecosystem",
    repo: "vercel-labs/skills",
    skills: ["find-skills"],
    matchAlways: true
  },
  {
    label: "Skill Authoring",
    description: "Create, audit, and refine SKILL.md files",
    repo: "anthropics/skills",
    skills: ["skill-creator"],
    matchAlways: true
  },
  {
    label: "Browser Automation",
    description: "Browser automation for web scraping, testing, and interaction",
    repo: "vercel-labs/agent-browser",
    skills: ["agent-browser"],
    matchAlways: true
  },
  // ── General Tooling ───────────────────────────────────────────────────────
  {
    label: "Document Handling",
    description: "PDF, DOCX, XLSX, PPTX creation and manipulation",
    repo: "anthropics/skills",
    skills: ["pdf", "docx", "xlsx", "pptx"],
    matchAlways: true
  },
  // ── Code Quality (wshobson/agents — matchAlways) ──────────────────────────
  {
    label: "Code Review & Quality",
    description: "Code review excellence and error handling patterns",
    repo: "wshobson/agents",
    skills: ["code-review-excellence", "error-handling-patterns"],
    matchAlways: true
  },
  {
    label: "Git Advanced Workflows",
    description: "Advanced Git rebasing, cherry-picking, bisect, worktrees, and reflog",
    repo: "wshobson/agents",
    skills: ["git-advanced-workflows"],
    matchAlways: true
  }
];
const GREENFIELD_STACKS = [
  {
    id: "ios",
    label: "iOS App",
    description: "Full iOS development \u2014 SwiftUI, Swift, and all iOS frameworks",
    packs: [
      "SwiftUI",
      "Swift Core",
      "iOS App Frameworks",
      "iOS Data Frameworks",
      "iOS AI & ML",
      "iOS Engineering",
      "iOS Hardware",
      "iOS Platform"
    ]
  },
  {
    id: "swift",
    label: "Swift (non-iOS)",
    description: "Swift packages, server-side Swift, CLI tools, SwiftUI without iOS",
    packs: ["SwiftUI", "Swift Core"]
  },
  {
    id: "react-web",
    label: "React Web",
    description: "React, Next.js, shadcn/ui, web frontend",
    packs: ["React & Web Frontend", "TypeScript & JS Development", "React State & Patterns", "Tailwind CSS", "shadcn/ui", "Frontend Design & UX"]
  },
  {
    id: "react-native",
    label: "React Native",
    description: "Cross-platform mobile with React Native",
    packs: ["React Native", "React Native Architecture", "React & Web Frontend", "TypeScript & JS Development"]
  },
  {
    id: "fullstack-js",
    label: "Full-Stack JavaScript/TypeScript",
    description: "Node.js backend + React frontend",
    packs: ["React & Web Frontend", "TypeScript & JS Development", "React State & Patterns", "Tailwind CSS", "shadcn/ui", "Frontend Design & UX", "Prisma"]
  },
  {
    id: "rust",
    label: "Rust",
    description: "Systems programming with Rust",
    packs: ["Rust", "Rust Async Patterns"]
  },
  {
    id: "python",
    label: "Python",
    description: "Python applications, scripts, or ML",
    packs: ["Python", "Python Advanced"]
  },
  {
    id: "go",
    label: "Go",
    description: "Go services and CLIs",
    packs: ["Go", "Go Concurrency Patterns"]
  },
  {
    id: "firebase",
    label: "Firebase",
    description: "Firebase backend \u2014 auth, Firestore, hosting, AI",
    packs: ["Firebase"]
  },
  {
    id: "aws",
    label: "AWS",
    description: "AWS deployment, Lambda, serverless",
    packs: ["AWS"]
  },
  {
    id: "azure",
    label: "Azure",
    description: "Azure deployment, AI, storage, diagnostics",
    packs: ["Azure"]
  },
  {
    id: "angular",
    label: "Angular",
    description: "Angular components, signals, forms, routing",
    packs: ["Angular", "Angular Migration", "Frontend Design & UX"]
  },
  {
    id: "vue",
    label: "Vue.js / Nuxt",
    description: "Vue.js with Pinia, Vue Router, and testing",
    packs: ["Vue.js", "Frontend Design & UX"]
  },
  {
    id: "svelte",
    label: "Svelte / SvelteKit",
    description: "Svelte 5 and SvelteKit patterns",
    packs: ["Svelte", "Tailwind CSS", "Frontend Design & UX"]
  },
  {
    id: "nextjs",
    label: "Next.js",
    description: "Next.js app router, React, and Vercel deployment",
    packs: ["Next.js", "Next.js App Router Patterns", "React & Web Frontend", "TypeScript & JS Development", "Tailwind CSS", "shadcn/ui"]
  },
  {
    id: "flutter",
    label: "Flutter",
    description: "Cross-platform Flutter/Dart development",
    packs: ["Flutter"]
  },
  {
    id: "java",
    label: "Java / Spring Boot",
    description: "Spring Boot APIs, JPA, and testing",
    packs: ["Java & Spring Boot"]
  },
  {
    id: "dotnet",
    label: ".NET / C#",
    description: "ASP.NET Core, Entity Framework, and design patterns",
    packs: [".NET & C#", ".NET Backend Patterns"]
  },
  {
    id: "php",
    label: "PHP / Laravel",
    description: "Laravel patterns and PHP best practices",
    packs: ["PHP & Laravel"]
  },
  {
    id: "django",
    label: "Django",
    description: "Django models, views, middleware, and Celery",
    packs: ["Django", "Python", "Python Advanced"]
  },
  {
    id: "fastapi",
    label: "FastAPI",
    description: "FastAPI web APIs with async patterns",
    packs: ["FastAPI", "Python", "Python Advanced"]
  },
  {
    id: "android",
    label: "Android / Kotlin",
    description: "Android app development with Material Design 3",
    packs: ["Android"]
  },
  {
    id: "kubernetes",
    label: "Kubernetes",
    description: "Kubernetes manifests, Helm charts, and GitOps",
    packs: ["Kubernetes", "Docker"]
  },
  {
    id: "blockchain",
    label: "Blockchain / Web3",
    description: "Solidity, DeFi protocols, and smart contract testing",
    packs: ["Blockchain & Web3"]
  },
  {
    id: "data-engineering",
    label: "Data Engineering",
    description: "dbt, Airflow, Spark, and data quality",
    packs: ["Data Engineering", "Python", "Python Advanced"]
  },
  {
    id: "unity",
    label: "Unity",
    description: "Unity game development with ECS patterns",
    packs: ["Unity"]
  },
  {
    id: "godot",
    label: "Godot",
    description: "Godot game development with GDScript",
    packs: ["Godot"]
  },
  {
    id: "other",
    label: "Other / Skip",
    description: "Install skills later with npx skills add",
    packs: []
  }
];
function matchPacksForProject(signals) {
  const matched = /* @__PURE__ */ new Set();
  for (const pack of SKILL_CATALOG) {
    if (pack.matchLanguages && signals.primaryLanguage) {
      if (pack.matchLanguages.includes(signals.primaryLanguage)) {
        matched.add(pack);
        continue;
      }
    }
    if (pack.matchFiles) {
      for (const file of pack.matchFiles) {
        if (signals.detectedFiles.includes(file)) {
          matched.add(pack);
          break;
        }
      }
    }
    if (pack.matchXcodePlatforms && signals.xcodePlatforms.length > 0) {
      const hasMatch = pack.matchXcodePlatforms.some((p) => signals.xcodePlatforms.includes(p));
      if (hasMatch) matched.add(pack);
    }
    if (pack.matchAlways) {
      matched.add(pack);
    }
  }
  return [...matched];
}
function installSkillPack(pack) {
  return new Promise((resolve) => {
    const args = ["--yes", "skills", "add", pack.repo];
    for (const skill of pack.skills) {
      args.push("--skill", skill);
    }
    args.push("-y");
    execFile("npx", args, { timeout: 12e4 }, (error) => {
      resolve(!error);
    });
  });
}
async function installPacksBatched(packs, onProgress) {
  const byRepo = /* @__PURE__ */ new Map();
  for (const pack of packs) {
    const entry = byRepo.get(pack.repo) ?? { skills: [], labels: [] };
    entry.skills.push(...pack.skills);
    entry.labels.push(pack.label);
    byRepo.set(pack.repo, entry);
  }
  const installed = [];
  for (const [repo, { skills, labels }] of byRepo) {
    onProgress?.(labels.join(", "));
    const ok = await new Promise((resolve) => {
      const args = ["--yes", "skills", "add", repo];
      for (const skill of skills) {
        args.push("--skill", skill);
      }
      args.push("-y");
      execFile("npx", args, { timeout: 12e4 }, (error) => {
        resolve(!error);
      });
    });
    if (ok) installed.push(...labels);
  }
  return installed;
}
function isPackInstalled(pack) {
  const skillsDirs = [
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".claude", "skills")
  ];
  return pack.skills.every(
    (name) => skillsDirs.some((dir) => existsSync(join(dir, name, "SKILL.md")))
  );
}
async function runSkillInstallStep(ctx, signals) {
  const installed = [];
  const isBrownfield = signals.detectedFiles.length > 0;
  if (isBrownfield) {
    const matched = matchPacksForProject(signals);
    if (matched.length === 0) return installed;
    const toInstall = matched.filter((p) => !isPackInstalled(p));
    if (toInstall.length === 0) return installed;
    const swiftPacks = toInstall.filter((p) => p.matchLanguages?.includes("swift"));
    const iosPacks = toInstall.filter((p) => p.matchXcodePlatforms?.includes("iphoneos"));
    const otherPacks = toInstall.filter((p) => !swiftPacks.includes(p) && !iosPacks.includes(p));
    const summaryLines = [];
    const hasIOS = signals.xcodePlatforms.includes("iphoneos");
    if (hasIOS) {
      summaryLines.push(`Detected: iOS project (${signals.primaryLanguage ?? "swift"})`);
    } else if (signals.xcodePlatforms.length > 0) {
      summaryLines.push(`Detected: ${signals.xcodePlatforms.join(", ")} Xcode project (${signals.primaryLanguage ?? "swift"})`);
    } else {
      summaryLines.push(`Detected: ${signals.primaryLanguage ?? "unknown"} project`);
    }
    summaryLines.push("");
    summaryLines.push("Recommended skill packs:");
    if (swiftPacks.length > 0) {
      summaryLines.push(`  Swift: ${swiftPacks.map((p) => p.label).join(", ")}`);
    }
    if (iosPacks.length > 0) {
      summaryLines.push(`  iOS: ${iosPacks.map((p) => p.label).join(", ")}`);
    }
    for (const p of otherPacks) {
      summaryLines.push(`  \u2022 ${p.label}: ${p.description}`);
    }
    const totalSkills = toInstall.reduce((n, p) => n + p.skills.length, 0);
    const choice = await showNextAction(ctx, {
      title: "GSD \u2014 Install Skills",
      summary: summaryLines,
      actions: [
        {
          id: "install",
          label: "Install recommended skills",
          description: `Install ${totalSkills} skills from ${toInstall.length} pack${toInstall.length > 1 ? "s" : ""} via skills.sh`,
          recommended: true
        },
        {
          id: "skip",
          label: "Skip",
          description: "Install skills later with npx skills add"
        }
      ],
      notYetMessage: "Run /gsd init when ready."
    });
    if (choice === "install") {
      const labels = await installPacksBatched(toInstall, (label) => {
        ctx.ui.notify(`Installing ${label} skills...`, "info");
      });
      installed.push(...labels);
      const failed = toInstall.filter((p) => !installed.includes(p.label));
      for (const pack of failed) {
        ctx.ui.notify(`Failed to install ${pack.label} \u2014 try manually: npx skills add ${pack.repo}`, "info");
      }
    }
  } else {
    const essentials = SKILL_CATALOG.filter((p) => p.matchAlways && !isPackInstalled(p));
    if (essentials.length === 0) return installed;
    const totalSkills = essentials.reduce((n, p) => n + p.skills.length, 0);
    const choice = await showNextAction(ctx, {
      title: "GSD \u2014 Install Essential Skills",
      summary: [
        "GSD will install essential agent skills (skill discovery, authoring,",
        "browser automation, document handling).",
        "",
        "Stack-specific skills (React, Swift, Python, etc.) will be recommended",
        "automatically once your project files are in place."
      ],
      actions: [
        {
          id: "install",
          label: "Install essentials",
          description: `Install ${totalSkills} essential skills via skills.sh`,
          recommended: true
        },
        {
          id: "skip",
          label: "Skip",
          description: "Install skills later with npx skills add"
        }
      ],
      notYetMessage: "Run /gsd init when ready."
    });
    if (choice === "install") {
      const labels = await installPacksBatched(essentials, (label) => {
        ctx.ui.notify(`Installing ${label} skills...`, "info");
      });
      installed.push(...labels);
    }
  }
  if (installed.length > 0) {
    ctx.ui.notify(`Installed: ${installed.join(", ")}`, "info");
  }
  return installed;
}
export {
  GREENFIELD_STACKS,
  SKILL_CATALOG,
  installPacksBatched,
  installSkillPack,
  isPackInstalled,
  matchPacksForProject,
  runSkillInstallStep
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9za2lsbC1jYXRhbG9nLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdTRCBTa2lsbCBDYXRhbG9nIFx1MjAxNCBDdXJhdGVkIHNraWxsIHBhY2tzIG1hcHBlZCB0byB0ZWNoIHN0YWNrcy5cbiAqXG4gKiBFYWNoIHBhY2sgbWFwcyBhIGRldGVjdGVkIChvciB1c2VyLWNob3NlbikgdGVjaCBzdGFjayB0byBhIHNraWxscy5zaFxuICogcmVwbyArIHNwZWNpZmljIHNraWxsIG5hbWVzLiAgVGhlIGluaXQgd2l6YXJkIHVzZXMgdGhpcyBjYXRhbG9nIHRvXG4gKiBpbnN0YWxsIHJlbGV2YW50IHNraWxscyBkdXJpbmcgcHJvamVjdCBvbmJvYXJkaW5nLlxuICpcbiAqIEluc3RhbGxhdGlvbiBpcyBkZWxlZ2F0ZWQgZW50aXJlbHkgdG8gdGhlIHNraWxscy5zaCBDTEk6XG4gKiAgIG5weCBza2lsbHMgYWRkIDxyZXBvPiAtLXNraWxsIDxuYW1lPiAtLXNraWxsIDxuYW1lPiAteVxuICpcbiAqIFNraWxscyBhcmUgaW5zdGFsbGVkIGludG8gfi8uYWdlbnRzL3NraWxscy8gKHRoZSBpbmR1c3RyeS1zdGFuZGFyZFxuICogZWNvc3lzdGVtIGRpcmVjdG9yeSBzaGFyZWQgYWNyb3NzIGFsbCBhZ2VudHMpLlxuICovXG5cbmltcG9ydCB7IGV4ZWNGaWxlIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBzaG93TmV4dEFjdGlvbiB9IGZyb20gXCIuLi9zaGFyZWQvdHVpLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFByb2plY3RTaWduYWxzLCBYY29kZVBsYXRmb3JtIH0gZnJvbSBcIi4vZGV0ZWN0aW9uLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDYXRhbG9nIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFNraWxsUGFjayB7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBuYW1lIHNob3duIGluIHRoZSB3aXphcmQgKi9cbiAgbGFiZWw6IHN0cmluZztcbiAgLyoqIFNob3J0IGRlc2NyaXB0aW9uICovXG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIC8qKiBza2lsbHMuc2ggcmVwbyBpZGVudGlmaWVyIChvd25lci9yZXBvKSAqL1xuICByZXBvOiBzdHJpbmc7XG4gIC8qKiBTcGVjaWZpYyBza2lsbCBuYW1lcyB0byBpbnN0YWxsIGZyb20gdGhlIHJlcG8gKi9cbiAgc2tpbGxzOiBzdHJpbmdbXTtcbiAgLyoqIFdoaWNoIGRldGVjdGVkIHByaW1hcnlMYW5ndWFnZSB2YWx1ZXMgdHJpZ2dlciB0aGlzIHBhY2sgKi9cbiAgbWF0Y2hMYW5ndWFnZXM/OiBzdHJpbmdbXTtcbiAgLyoqIFdoaWNoIGRldGVjdGVkIHByb2plY3QgZmlsZXMgdHJpZ2dlciB0aGlzIHBhY2sgKi9cbiAgbWF0Y2hGaWxlcz86IHN0cmluZ1tdO1xuICAvKiogVHJpZ2dlciB3aGVuIFhjb2RlIHByb2plY3QgdGFyZ2V0cyBvbmUgb2YgdGhlc2UgcGxhdGZvcm1zICovXG4gIG1hdGNoWGNvZGVQbGF0Zm9ybXM/OiBYY29kZVBsYXRmb3JtW107XG4gIC8qKiBBbHdheXMgaW5jbHVkZSB0aGlzIHBhY2sgaW4gYnJvd25maWVsZCByZWNvbW1lbmRhdGlvbnMgKi9cbiAgbWF0Y2hBbHdheXM/OiBib29sZWFuO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ3VyYXRlZCBDYXRhbG9nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgY29uc3QgU0tJTExfQ0FUQUxPRzogU2tpbGxQYWNrW10gPSBbXG4gIC8vIFx1MjUwMFx1MjUwMCBTd2lmdCAobGFuZ3VhZ2UtbGV2ZWwgXHUyMDE0IGFueSBTd2lmdCBwcm9qZWN0KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIlN3aWZ0VUlcIixcbiAgICBkZXNjcmlwdGlvbjogXCJTd2lmdFVJIGxheW91dCwgbmF2aWdhdGlvbiwgYW5pbWF0aW9ucywgZ2VzdHVyZXMsIExpcXVpZCBHbGFzc1wiLFxuICAgIHJlcG86IFwiZHBlYXJzb24yNjk5L3N3aWZ0LWlvcy1za2lsbHNcIixcbiAgICBza2lsbHM6IFtcbiAgICAgIFwic3dpZnR1aS1hbmltYXRpb25cIixcbiAgICAgIFwic3dpZnR1aS1nZXN0dXJlc1wiLFxuICAgICAgXCJzd2lmdHVpLWxheW91dC1jb21wb25lbnRzXCIsXG4gICAgICBcInN3aWZ0dWktbGlxdWlkLWdsYXNzXCIsXG4gICAgICBcInN3aWZ0dWktbmF2aWdhdGlvblwiLFxuICAgICAgXCJzd2lmdHVpLXBhdHRlcm5zXCIsXG4gICAgICBcInN3aWZ0dWktcGVyZm9ybWFuY2VcIixcbiAgICAgIFwic3dpZnR1aS11aWtpdC1pbnRlcm9wXCIsXG4gICAgXSxcbiAgICBtYXRjaExhbmd1YWdlczogW1wic3dpZnRcIl0sXG4gICAgbWF0Y2hGaWxlczogW1wiUGFja2FnZS5zd2lmdFwiXSxcbiAgfSxcbiAge1xuICAgIGxhYmVsOiBcIlN3aWZ0IENvcmVcIixcbiAgICBkZXNjcmlwdGlvbjogXCJTd2lmdCBsYW5ndWFnZSwgY29uY3VycmVuY3ksIENvZGFibGUsIENoYXJ0cywgVGVzdGluZywgU3dpZnREYXRhXCIsXG4gICAgcmVwbzogXCJkcGVhcnNvbjI2OTkvc3dpZnQtaW9zLXNraWxsc1wiLFxuICAgIHNraWxsczogW1xuICAgICAgXCJzd2lmdC1jb2RhYmxlXCIsXG4gICAgICBcInN3aWZ0LWNoYXJ0c1wiLFxuICAgICAgXCJzd2lmdC1jb25jdXJyZW5jeVwiLFxuICAgICAgXCJzd2lmdC1sYW5ndWFnZVwiLFxuICAgICAgXCJzd2lmdC10ZXN0aW5nXCIsXG4gICAgICBcInN3aWZ0ZGF0YVwiLFxuICAgIF0sXG4gICAgbWF0Y2hMYW5ndWFnZXM6IFtcInN3aWZ0XCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcIlBhY2thZ2Uuc3dpZnRcIl0sXG4gIH0sXG4gIC8vIFx1MjUwMFx1MjUwMCBpT1MgKFhjb2RlIHByb2plY3QgdGFyZ2V0aW5nIGlwaG9uZW9zIHJlcXVpcmVkKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcImlPUyBBcHAgRnJhbWV3b3Jrc1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkFwcCBJbnRlbnRzLCBXaWRnZXRzLCBTdG9yZUtpdCwgTWFwS2l0LCBMaXZlIEFjdGl2aXRpZXMsIHB1c2ggbm90aWZpY2F0aW9uc1wiLFxuICAgIHJlcG86IFwiZHBlYXJzb24yNjk5L3N3aWZ0LWlvcy1za2lsbHNcIixcbiAgICBza2lsbHM6IFtcbiAgICAgIFwiYWxhcm1raXRcIixcbiAgICAgIFwiYXBwLWNsaXBzXCIsXG4gICAgICBcImFwcC1pbnRlbnRzXCIsXG4gICAgICBcImxpdmUtYWN0aXZpdGllc1wiLFxuICAgICAgXCJtYXBraXQtbG9jYXRpb25cIixcbiAgICAgIFwicGhvdG9zLWNhbWVyYS1tZWRpYVwiLFxuICAgICAgXCJwdXNoLW5vdGlmaWNhdGlvbnNcIixcbiAgICAgIFwic3RvcmVraXRcIixcbiAgICAgIFwidGlwa2l0XCIsXG4gICAgICBcIndpZGdldGtpdFwiLFxuICAgIF0sXG4gICAgbWF0Y2hYY29kZVBsYXRmb3JtczogW1wiaXBob25lb3NcIl0sXG4gIH0sXG4gIHtcbiAgICBsYWJlbDogXCJpT1MgRGF0YSBGcmFtZXdvcmtzXCIsXG4gICAgZGVzY3JpcHRpb246IFwiQ2xvdWRLaXQsIEhlYWx0aEtpdCwgTXVzaWNLaXQsIFdlYXRoZXJLaXQsIENvbnRhY3RzLCBDYWxlbmRhclwiLFxuICAgIHJlcG86IFwiZHBlYXJzb24yNjk5L3N3aWZ0LWlvcy1za2lsbHNcIixcbiAgICBza2lsbHM6IFtcbiAgICAgIFwiY2xvdWRraXQtc3luY1wiLFxuICAgICAgXCJjb250YWN0cy1mcmFtZXdvcmtcIixcbiAgICAgIFwiZXZlbnRraXQtY2FsZW5kYXJcIixcbiAgICAgIFwiaGVhbHRoa2l0XCIsXG4gICAgICBcIm11c2lja2l0LWF1ZGlvXCIsXG4gICAgICBcInBhc3NraXQtd2FsbGV0XCIsXG4gICAgICBcIndlYXRoZXJraXRcIixcbiAgICBdLFxuICAgIG1hdGNoWGNvZGVQbGF0Zm9ybXM6IFtcImlwaG9uZW9zXCJdLFxuICB9LFxuICB7XG4gICAgbGFiZWw6IFwiaU9TIEFJICYgTUxcIixcbiAgICBkZXNjcmlwdGlvbjogXCJDb3JlIE1MLCBWaXNpb24sIG9uLWRldmljZSBBSSwgc3BlZWNoIHJlY29nbml0aW9uLCBOTFBcIixcbiAgICByZXBvOiBcImRwZWFyc29uMjY5OS9zd2lmdC1pb3Mtc2tpbGxzXCIsXG4gICAgc2tpbGxzOiBbXG4gICAgICBcImFwcGxlLW9uLWRldmljZS1haVwiLFxuICAgICAgXCJjb3JlbWxcIixcbiAgICAgIFwibmF0dXJhbC1sYW5ndWFnZVwiLFxuICAgICAgXCJzcGVlY2gtcmVjb2duaXRpb25cIixcbiAgICAgIFwidmlzaW9uLWZyYW1ld29ya1wiLFxuICAgIF0sXG4gICAgbWF0Y2hYY29kZVBsYXRmb3JtczogW1wiaXBob25lb3NcIl0sXG4gIH0sXG4gIHtcbiAgICBsYWJlbDogXCJpT1MgRW5naW5lZXJpbmdcIixcbiAgICBkZXNjcmlwdGlvbjogXCJOZXR3b3JraW5nLCBzZWN1cml0eSwgYWNjZXNzaWJpbGl0eSwgbG9jYWxpemF0aW9uLCBJbnN0cnVtZW50cywgQXBwIFN0b3JlIHJldmlld1wiLFxuICAgIHJlcG86IFwiZHBlYXJzb24yNjk5L3N3aWZ0LWlvcy1za2lsbHNcIixcbiAgICBza2lsbHM6IFtcbiAgICAgIFwiYXBwLXN0b3JlLXJldmlld1wiLFxuICAgICAgXCJhdXRoZW50aWNhdGlvblwiLFxuICAgICAgXCJiYWNrZ3JvdW5kLXByb2Nlc3NpbmdcIixcbiAgICAgIFwiZGVidWdnaW5nLWluc3RydW1lbnRzXCIsXG4gICAgICBcImRldmljZS1pbnRlZ3JpdHlcIixcbiAgICAgIFwiaW9zLWFjY2Vzc2liaWxpdHlcIixcbiAgICAgIFwiaW9zLWxvY2FsaXphdGlvblwiLFxuICAgICAgXCJpb3MtbmV0d29ya2luZ1wiLFxuICAgICAgXCJpb3Mtc2VjdXJpdHlcIixcbiAgICAgIFwibWV0cmlja2l0LWRpYWdub3N0aWNzXCIsXG4gICAgXSxcbiAgICBtYXRjaFhjb2RlUGxhdGZvcm1zOiBbXCJpcGhvbmVvc1wiXSxcbiAgfSxcbiAge1xuICAgIGxhYmVsOiBcImlPUyBIYXJkd2FyZVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkJsdWV0b290aCwgQ29yZU1vdGlvbiwgTkZDLCBQZW5jaWxLaXQsIFJlYWxpdHlLaXQgQVJcIixcbiAgICByZXBvOiBcImRwZWFyc29uMjY5OS9zd2lmdC1pb3Mtc2tpbGxzXCIsXG4gICAgc2tpbGxzOiBbXG4gICAgICBcImNvcmUtYmx1ZXRvb3RoXCIsXG4gICAgICBcImNvcmUtbW90aW9uXCIsXG4gICAgICBcImNvcmUtbmZjXCIsXG4gICAgICBcInBlbmNpbGtpdC1kcmF3aW5nXCIsXG4gICAgICBcInJlYWxpdHlraXQtYXJcIixcbiAgICBdLFxuICAgIG1hdGNoWGNvZGVQbGF0Zm9ybXM6IFtcImlwaG9uZW9zXCJdLFxuICB9LFxuICB7XG4gICAgbGFiZWw6IFwiaU9TIFBsYXRmb3JtXCIsXG4gICAgZGVzY3JpcHRpb246IFwiQ2FsbEtpdCwgRW5lcmd5S2l0LCBIb21lS2l0LCBTaGFyZVBsYXksIFBlcm1pc3Npb25LaXRcIixcbiAgICByZXBvOiBcImRwZWFyc29uMjY5OS9zd2lmdC1pb3Mtc2tpbGxzXCIsXG4gICAgc2tpbGxzOiBbXG4gICAgICBcImNhbGxraXQtdm9pcFwiLFxuICAgICAgXCJlbmVyZ3lraXRcIixcbiAgICAgIFwiaG9tZWtpdC1tYXR0ZXJcIixcbiAgICAgIFwicGVybWlzc2lvbmtpdFwiLFxuICAgICAgXCJzaGFyZXBsYXktYWN0aXZpdGllc1wiLFxuICAgIF0sXG4gICAgbWF0Y2hYY29kZVBsYXRmb3JtczogW1wiaXBob25lb3NcIl0sXG4gIH0sXG4gIC8vIFx1MjUwMFx1MjUwMCBSZWFjdCAvIE5leHQuanMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHtcbiAgICBsYWJlbDogXCJSZWFjdCAmIFdlYiBGcm9udGVuZFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlJlYWN0IGJlc3QgcHJhY3RpY2VzIGFuZCBjb21wb3NpdGlvbiBwYXR0ZXJuc1wiLFxuICAgIHJlcG86IFwidmVyY2VsLWxhYnMvYWdlbnQtc2tpbGxzXCIsXG4gICAgc2tpbGxzOiBbXG4gICAgICBcInZlcmNlbC1yZWFjdC1iZXN0LXByYWN0aWNlc1wiLFxuICAgICAgXCJ2ZXJjZWwtY29tcG9zaXRpb24tcGF0dGVybnNcIixcbiAgICBdLFxuICAgIG1hdGNoTGFuZ3VhZ2VzOiBbXCJqYXZhc2NyaXB0L3R5cGVzY3JpcHRcIl0sXG4gIH0sXG4gIHtcbiAgICBsYWJlbDogXCJzaGFkY24vdWlcIixcbiAgICBkZXNjcmlwdGlvbjogXCJzaGFkY24vdWkgY29tcG9uZW50IGxpYnJhcnkgcGF0dGVybnMgYW5kIHVzYWdlXCIsXG4gICAgcmVwbzogXCJzaGFkY24vdWlcIixcbiAgICBza2lsbHM6IFtcInNoYWRjblwiXSxcbiAgICBtYXRjaExhbmd1YWdlczogW1wiamF2YXNjcmlwdC90eXBlc2NyaXB0XCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgUmVhY3QgTmF0aXZlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB7XG4gICAgbGFiZWw6IFwiUmVhY3QgTmF0aXZlXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUmVhY3QgTmF0aXZlIGFuZCBFeHBvIGJlc3QgcHJhY3RpY2VzIGZvciBwZXJmb3JtYW50IG1vYmlsZSBhcHBzXCIsXG4gICAgcmVwbzogXCJ2ZXJjZWwtbGFicy9hZ2VudC1za2lsbHNcIixcbiAgICBza2lsbHM6IFtcInZlcmNlbC1yZWFjdC1uYXRpdmUtc2tpbGxzXCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcIm1ldHJvLmNvbmZpZy5qc1wiLCBcIm1ldHJvLmNvbmZpZy50c1wiLCBcInJlYWN0LW5hdGl2ZS5jb25maWcuanNcIl0sXG4gIH0sXG4gIHtcbiAgICBsYWJlbDogXCJSZWFjdCBOYXRpdmUgQXJjaGl0ZWN0dXJlXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUmVhY3QgTmF0aXZlIGFwcCBhcmNoaXRlY3R1cmUsIG5hdmlnYXRpb24sIGFuZCBjcm9zcy1wbGF0Zm9ybSBkZXNpZ24gcGF0dGVybnNcIixcbiAgICByZXBvOiBcIndzaG9ic29uL2FnZW50c1wiLFxuICAgIHNraWxsczogW1wicmVhY3QtbmF0aXZlLWFyY2hpdGVjdHVyZVwiLCBcInJlYWN0LW5hdGl2ZS1kZXNpZ25cIl0sXG4gICAgbWF0Y2hGaWxlczogW1wibWV0cm8uY29uZmlnLmpzXCIsIFwibWV0cm8uY29uZmlnLnRzXCIsIFwicmVhY3QtbmF0aXZlLmNvbmZpZy5qc1wiXSxcbiAgfSxcbiAgLy8gXHUyNTAwXHUyNTAwIFR5cGVTY3JpcHQgJiBKUyBFY29zeXN0ZW0gKHdzaG9ic29uL2FnZW50cyBcdTIwMTQgNDFLIGNvbWJpbmVkIGluc3RhbGxzKSBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIlR5cGVTY3JpcHQgJiBKUyBEZXZlbG9wbWVudFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkFkdmFuY2VkIFR5cGVTY3JpcHQgdHlwZXMsIE5vZGUuanMgYmFja2VuZCwgdGVzdGluZywgYW5kIG1vZGVybiBKUyBwYXR0ZXJuc1wiLFxuICAgIHJlcG86IFwid3Nob2Jzb24vYWdlbnRzXCIsXG4gICAgc2tpbGxzOiBbXG4gICAgICBcInR5cGVzY3JpcHQtYWR2YW5jZWQtdHlwZXNcIixcbiAgICAgIFwibm9kZWpzLWJhY2tlbmQtcGF0dGVybnNcIixcbiAgICAgIFwiamF2YXNjcmlwdC10ZXN0aW5nLXBhdHRlcm5zXCIsXG4gICAgICBcIm1vZGVybi1qYXZhc2NyaXB0LXBhdHRlcm5zXCIsXG4gICAgXSxcbiAgICBtYXRjaExhbmd1YWdlczogW1wiamF2YXNjcmlwdC90eXBlc2NyaXB0XCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgUmVhY3QgU3RhdGUgKHdzaG9ic29uL2FnZW50cyBcdTIwMTQgOC4xSyBjb21iaW5lZCBpbnN0YWxscykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHtcbiAgICBsYWJlbDogXCJSZWFjdCBTdGF0ZSAmIFBhdHRlcm5zXCIsXG4gICAgZGVzY3JpcHRpb246IFwiU3RhdGUgbWFuYWdlbWVudCB3aXRoIFp1c3RhbmQsIEpvdGFpLCBSZWFjdCBRdWVyeSwgYW5kIFJlYWN0IG1vZGVybml6YXRpb25cIixcbiAgICByZXBvOiBcIndzaG9ic29uL2FnZW50c1wiLFxuICAgIHNraWxsczogW1wicmVhY3Qtc3RhdGUtbWFuYWdlbWVudFwiLCBcInJlYWN0LW1vZGVybml6YXRpb25cIl0sXG4gICAgbWF0Y2hMYW5ndWFnZXM6IFtcImphdmFzY3JpcHQvdHlwZXNjcmlwdFwiXSxcbiAgfSxcbiAgLy8gXHUyNTAwXHUyNTAwIFRhaWx3aW5kIENTUyAod3Nob2Jzb24vYWdlbnRzIFx1MjAxNCAyMi44SyBpbnN0YWxscykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHtcbiAgICBsYWJlbDogXCJUYWlsd2luZCBDU1NcIixcbiAgICBkZXNjcmlwdGlvbjogXCJUYWlsd2luZCB2NCBkZXNpZ24gc3lzdGVtLCBDVkEgcGF0dGVybnMsIGFuZCB1dGlsaXR5LWZpcnN0IENTU1wiLFxuICAgIHJlcG86IFwid3Nob2Jzb24vYWdlbnRzXCIsXG4gICAgc2tpbGxzOiBbXCJ0YWlsd2luZC1kZXNpZ24tc3lzdGVtXCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcbiAgICAgIFwidGFpbHdpbmQuY29uZmlnLmpzXCIsXG4gICAgICBcInRhaWx3aW5kLmNvbmZpZy50c1wiLFxuICAgICAgXCJ0YWlsd2luZC5jb25maWcubWpzXCIsXG4gICAgICBcInRhaWx3aW5kLmNvbmZpZy5janNcIixcbiAgICBdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgR2VuZXJhbCBGcm9udGVuZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIkZyb250ZW5kIERlc2lnbiAmIFVYXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRnJvbnRlbmQgZGVzaWduLCBhY2Nlc3NpYmlsaXR5LCBhbmQgYnJvd3NlciBhdXRvbWF0aW9uXCIsXG4gICAgcmVwbzogXCJhbnRocm9waWNzL3NraWxsc1wiLFxuICAgIHNraWxsczogW1wiZnJvbnRlbmQtZGVzaWduXCJdLFxuICAgIG1hdGNoTGFuZ3VhZ2VzOiBbXCJqYXZhc2NyaXB0L3R5cGVzY3JpcHRcIl0sXG4gIH0sXG4gIC8vIFx1MjUwMFx1MjUwMCBBbmd1bGFyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB7XG4gICAgbGFiZWw6IFwiQW5ndWxhclwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkFuZ3VsYXIgY29tcG9uZW50cywgc2lnbmFscywgZm9ybXMsIHJvdXRpbmcsIGFuZCB0ZXN0aW5nXCIsXG4gICAgcmVwbzogXCJhbmFsb2dqcy9hbmd1bGFyLXNraWxsc1wiLFxuICAgIHNraWxsczogW1xuICAgICAgXCJhbmd1bGFyLWNvbXBvbmVudFwiLFxuICAgICAgXCJhbmd1bGFyLXNpZ25hbHNcIixcbiAgICAgIFwiYW5ndWxhci1mb3Jtc1wiLFxuICAgICAgXCJhbmd1bGFyLXJvdXRpbmdcIixcbiAgICAgIFwiYW5ndWxhci10ZXN0aW5nXCIsXG4gICAgXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJhbmd1bGFyLmpzb25cIl0sXG4gIH0sXG4gIHtcbiAgICBsYWJlbDogXCJBbmd1bGFyIE1pZ3JhdGlvblwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIk1pZ3JhdGUgZnJvbSBBbmd1bGFySlMgdG8gQW5ndWxhciB3aXRoIGh5YnJpZCBtb2RlIGFuZCBpbmNyZW1lbnRhbCByZXdyaXRpbmdcIixcbiAgICByZXBvOiBcIndzaG9ic29uL2FnZW50c1wiLFxuICAgIHNraWxsczogW1wiYW5ndWxhci1taWdyYXRpb25cIl0sXG4gICAgbWF0Y2hGaWxlczogW1wiYW5ndWxhci5qc29uXCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgVnVlLmpzIC8gTnV4dCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIlZ1ZS5qc1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlZ1ZSBiZXN0IHByYWN0aWNlcywgUGluaWEgc3RhdGUsIFZ1ZSBSb3V0ZXIsIGFuZCB0ZXN0aW5nXCIsXG4gICAgcmVwbzogXCJ2dWVqcy1haS9za2lsbHNcIixcbiAgICBza2lsbHM6IFtcbiAgICAgIFwidnVlLWJlc3QtcHJhY3RpY2VzXCIsXG4gICAgICBcInZ1ZS1waW5pYS1iZXN0LXByYWN0aWNlc1wiLFxuICAgICAgXCJ2dWUtcm91dGVyLWJlc3QtcHJhY3RpY2VzXCIsXG4gICAgICBcInZ1ZS10ZXN0aW5nLWJlc3QtcHJhY3RpY2VzXCIsXG4gICAgXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJudXh0LmNvbmZpZy50c1wiLCBcIm51eHQuY29uZmlnLmpzXCIsIFwidnVlLmNvbmZpZy5qc1wiLCBcInZ1ZS5jb25maWcudHNcIiwgXCIqLnZ1ZVwiXSxcbiAgfSxcbiAgLy8gXHUyNTAwXHUyNTAwIFN2ZWx0ZSAvIFN2ZWx0ZUtpdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIlN2ZWx0ZVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlN2ZWx0ZSBjb2RlIHBhdHRlcm5zIGFuZCBTdmVsdGVLaXQgYmVzdCBwcmFjdGljZXNcIixcbiAgICByZXBvOiBcInN2ZWx0ZWpzL2FpLXRvb2xzXCIsXG4gICAgc2tpbGxzOiBbXCJzdmVsdGUtY29kZS13cml0ZXJcIiwgXCJzdmVsdGUtY29yZS1iZXN0cHJhY3RpY2VzXCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcInN2ZWx0ZS5jb25maWcuanNcIiwgXCJzdmVsdGUuY29uZmlnLnRzXCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgTmV4dC5qcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIk5leHQuanNcIixcbiAgICBkZXNjcmlwdGlvbjogXCJOZXh0LmpzIGFwcCByb3V0ZXIsIHNlcnZlciBjb21wb25lbnRzLCBhbmQgZGVwbG95bWVudCBwYXR0ZXJuc1wiLFxuICAgIHJlcG86IFwidmVyY2VsLWxhYnMvdmVyY2VsLXBsdWdpblwiLFxuICAgIHNraWxsczogW1wibmV4dGpzXCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcIm5leHQuY29uZmlnLmpzXCIsIFwibmV4dC5jb25maWcudHNcIiwgXCJuZXh0LmNvbmZpZy5tanNcIl0sXG4gIH0sXG4gIHtcbiAgICBsYWJlbDogXCJOZXh0LmpzIEFwcCBSb3V0ZXIgUGF0dGVybnNcIixcbiAgICBkZXNjcmlwdGlvbjogXCJOZXh0LmpzIDE0KyBBcHAgUm91dGVyLCBSZWFjdCBTZXJ2ZXIgQ29tcG9uZW50cywgYW5kIHN0cmVhbWluZ1wiLFxuICAgIHJlcG86IFwid3Nob2Jzb24vYWdlbnRzXCIsXG4gICAgc2tpbGxzOiBbXCJuZXh0anMtYXBwLXJvdXRlci1wYXR0ZXJuc1wiXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJuZXh0LmNvbmZpZy5qc1wiLCBcIm5leHQuY29uZmlnLnRzXCIsIFwibmV4dC5jb25maWcubWpzXCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgSmF2YSAvIFNwcmluZyBCb290IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB7XG4gICAgbGFiZWw6IFwiSmF2YSAmIFNwcmluZyBCb290XCIsXG4gICAgZGVzY3JpcHRpb246IFwiU3ByaW5nIEJvb3QgYmVzdCBwcmFjdGljZXMsIERJLCBSRVNUZnVsIEFQSXMsIEpQQSwgdGVzdGluZywgYW5kIHNlY3VyaXR5XCIsXG4gICAgcmVwbzogXCJnaXRodWIvYXdlc29tZS1jb3BpbG90XCIsXG4gICAgc2tpbGxzOiBbXCJqYXZhLXNwcmluZ2Jvb3RcIl0sXG4gICAgbWF0Y2hGaWxlczogW1wiZGVwOnNwcmluZy1ib290XCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgLk5FVCAvIEMjIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB7XG4gICAgbGFiZWw6IFwiLk5FVCAmIEMjXCIsXG4gICAgZGVzY3JpcHRpb246IFwiLk5FVCBiZXN0IHByYWN0aWNlcywgZGVzaWduIHBhdHRlcm5zLCBhbmQgdXBncmFkZSBndWlkYW5jZVwiLFxuICAgIHJlcG86IFwiZ2l0aHViL2F3ZXNvbWUtY29waWxvdFwiLFxuICAgIHNraWxsczogW1wiZG90bmV0LWJlc3QtcHJhY3RpY2VzXCIsIFwiZG90bmV0LWRlc2lnbi1wYXR0ZXJuLXJldmlld1wiXSxcbiAgICBtYXRjaExhbmd1YWdlczogW1wiY3NoYXJwXCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcIiouY3Nwcm9qXCJdLFxuICB9LFxuICB7XG4gICAgbGFiZWw6IFwiLk5FVCBCYWNrZW5kIFBhdHRlcm5zXCIsXG4gICAgZGVzY3JpcHRpb246IFwiLk5FVCBiYWNrZW5kIGFyY2hpdGVjdHVyZSwgbWlkZGxld2FyZSwgYW5kIHByb2R1Y3Rpb24gcGF0dGVybnNcIixcbiAgICByZXBvOiBcIndzaG9ic29uL2FnZW50c1wiLFxuICAgIHNraWxsczogW1wiZG90bmV0LWJhY2tlbmQtcGF0dGVybnNcIl0sXG4gICAgbWF0Y2hGaWxlczogW1wiKi5jc3Byb2pcIiwgXCIqLmZzcHJvalwiLCBcIiouc2xuXCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgRmx1dHRlciAvIERhcnQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHtcbiAgICBsYWJlbDogXCJGbHV0dGVyXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRmx1dHRlciBsYXlvdXRzLCBhcmNoaXRlY3R1cmUsIHN0YXRlIG1hbmFnZW1lbnQsIGFuZCB0ZXN0aW5nXCIsXG4gICAgcmVwbzogXCJmbHV0dGVyL3NraWxsc1wiLFxuICAgIHNraWxsczogW1xuICAgICAgXCJmbHV0dGVyLWJ1aWxkaW5nLWxheW91dHNcIixcbiAgICAgIFwiZmx1dHRlci1hcmNoaXRlY3RpbmctYXBwc1wiLFxuICAgICAgXCJmbHV0dGVyLW1hbmFnaW5nLXN0YXRlXCIsXG4gICAgICBcImZsdXR0ZXItdGVzdGluZy1hcHBzXCIsXG4gICAgXSxcbiAgICBtYXRjaExhbmd1YWdlczogW1wiZGFydC9mbHV0dGVyXCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcInB1YnNwZWMueWFtbFwiXSxcbiAgfSxcbiAgLy8gXHUyNTAwXHUyNTAwIFBIUCAvIExhcmF2ZWwgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHtcbiAgICBsYWJlbDogXCJQSFAgJiBMYXJhdmVsXCIsXG4gICAgZGVzY3JpcHRpb246IFwiTGFyYXZlbCBwYXR0ZXJucywgUEhQIGJlc3QgcHJhY3RpY2VzLCBhbmQgdGVzdGluZ1wiLFxuICAgIHJlcG86IFwiamVmZmFsbGFuL2NsYXVkZS1za2lsbHNcIixcbiAgICBza2lsbHM6IFtcImxhcmF2ZWwtc3BlY2lhbGlzdFwiLCBcInBocC1wcm9cIl0sXG4gICAgbWF0Y2hMYW5ndWFnZXM6IFtcInBocFwiXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJjb21wb3Nlci5qc29uXCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgRGphbmdvIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB7XG4gICAgbGFiZWw6IFwiRGphbmdvXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRGphbmdvIGV4cGVydCBwYXR0ZXJucywgbW9kZWxzLCB2aWV3cywgYW5kIG1pZGRsZXdhcmVcIixcbiAgICByZXBvOiBcInZpbnRhc29mdHdhcmUvZGphbmdvLWFpLXBsdWdpbnNcIixcbiAgICBza2lsbHM6IFtcImRqYW5nby1leHBlcnRcIl0sXG4gICAgbWF0Y2hGaWxlczogW1wibWFuYWdlLnB5XCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgUnVzdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIlJ1c3RcIixcbiAgICBkZXNjcmlwdGlvbjogXCJSdXN0IGxhbmd1YWdlIHBhdHRlcm5zIGFuZCBiZXN0IHByYWN0aWNlc1wiLFxuICAgIHJlcG86IFwiYW50aHJvcGljcy9za2lsbHNcIixcbiAgICBza2lsbHM6IFtcInJ1c3QtYmVzdC1wcmFjdGljZXNcIl0sXG4gICAgbWF0Y2hMYW5ndWFnZXM6IFtcInJ1c3RcIl0sXG4gICAgbWF0Y2hGaWxlczogW1wiQ2FyZ28udG9tbFwiXSxcbiAgfSxcbiAge1xuICAgIGxhYmVsOiBcIlJ1c3QgQXN5bmMgUGF0dGVybnNcIixcbiAgICBkZXNjcmlwdGlvbjogXCJBc3luYyBSdXN0IHdpdGggVG9raW8sIGZ1dHVyZXMsIGFuZCBwcm9wZXIgZXJyb3IgaGFuZGxpbmdcIixcbiAgICByZXBvOiBcIndzaG9ic29uL2FnZW50c1wiLFxuICAgIHNraWxsczogW1wicnVzdC1hc3luYy1wYXR0ZXJuc1wiXSxcbiAgICBtYXRjaExhbmd1YWdlczogW1wicnVzdFwiXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJDYXJnby50b21sXCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgUHl0aG9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB7XG4gICAgbGFiZWw6IFwiUHl0aG9uXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUHl0aG9uIHBhdHRlcm5zIGFuZCBiZXN0IHByYWN0aWNlc1wiLFxuICAgIHJlcG86IFwiYW50aHJvcGljcy9za2lsbHNcIixcbiAgICBza2lsbHM6IFtcInB5dGhvbi1iZXN0LXByYWN0aWNlc1wiXSxcbiAgICBtYXRjaExhbmd1YWdlczogW1wicHl0aG9uXCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcInB5cHJvamVjdC50b21sXCIsIFwic2V0dXAucHlcIiwgXCJyZXF1aXJlbWVudHMudHh0XCJdLFxuICB9LFxuICB7XG4gICAgbGFiZWw6IFwiUHl0aG9uIEFkdmFuY2VkXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUHl0aG9uIHBlcmZvcm1hbmNlLCB0ZXN0aW5nLCBhc3luYyBwYXR0ZXJucywgYW5kIHV2IHBhY2thZ2UgbWFuYWdlclwiLFxuICAgIHJlcG86IFwid3Nob2Jzb24vYWdlbnRzXCIsXG4gICAgc2tpbGxzOiBbXG4gICAgICBcInB5dGhvbi1wZXJmb3JtYW5jZS1vcHRpbWl6YXRpb25cIixcbiAgICAgIFwicHl0aG9uLXRlc3RpbmctcGF0dGVybnNcIixcbiAgICAgIFwiYXN5bmMtcHl0aG9uLXBhdHRlcm5zXCIsXG4gICAgICBcInV2LXBhY2thZ2UtbWFuYWdlclwiLFxuICAgIF0sXG4gICAgbWF0Y2hMYW5ndWFnZXM6IFtcInB5dGhvblwiXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJweXByb2plY3QudG9tbFwiLCBcInNldHVwLnB5XCIsIFwicmVxdWlyZW1lbnRzLnR4dFwiXSxcbiAgfSxcbiAgLy8gRmFzdEFQSSBcdTIwMTQgZGV0ZWN0ZWQgYnkgc2Nhbm5pbmcgcmVxdWlyZW1lbnRzLnR4dCAvIHB5cHJvamVjdC50b21sIGZvciB0aGVcbiAgLy8gXCJmYXN0YXBpXCIgZGVwZW5kZW5jeS4gVXNlcyB0aGUgXCJkZXA6ZmFzdGFwaVwiIHN5bnRoZXRpYyBtYXJrZXIgZnJvbSBkZXRlY3Rpb24udHMuXG4gIHtcbiAgICBsYWJlbDogXCJGYXN0QVBJXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUHJvZHVjdGlvbi1yZWFkeSBGYXN0QVBJIHByb2plY3RzIHdpdGggYXN5bmMgcGF0dGVybnMgYW5kIGVycm9yIGhhbmRsaW5nXCIsXG4gICAgcmVwbzogXCJ3c2hvYnNvbi9hZ2VudHNcIixcbiAgICBza2lsbHM6IFtcImZhc3RhcGktdGVtcGxhdGVzXCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcImRlcDpmYXN0YXBpXCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgR28gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHtcbiAgICBsYWJlbDogXCJHb1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkdvIGxhbmd1YWdlIHBhdHRlcm5zIGFuZCBiZXN0IHByYWN0aWNlc1wiLFxuICAgIHJlcG86IFwiYW50aHJvcGljcy9za2lsbHNcIixcbiAgICBza2lsbHM6IFtcImdvLWJlc3QtcHJhY3RpY2VzXCJdLFxuICAgIG1hdGNoTGFuZ3VhZ2VzOiBbXCJnb1wiXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJnby5tb2RcIl0sXG4gIH0sXG4gIHtcbiAgICBsYWJlbDogXCJHbyBDb25jdXJyZW5jeSBQYXR0ZXJuc1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkdvIGNvbmN1cnJlbmN5IHdpdGggY2hhbm5lbHMsIHdvcmtlciBwb29scywgYW5kIGNvbnRleHQgY2FuY2VsbGF0aW9uXCIsXG4gICAgcmVwbzogXCJ3c2hvYnNvbi9hZ2VudHNcIixcbiAgICBza2lsbHM6IFtcImdvLWNvbmN1cnJlbmN5LXBhdHRlcm5zXCJdLFxuICAgIG1hdGNoTGFuZ3VhZ2VzOiBbXCJnb1wiXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJnby5tb2RcIl0sXG4gIH0sXG4gIC8vIFx1MjUwMFx1MjUwMCBEYXRhYmFzZSAvIE9STSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIlByaXNtYVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlByaXNtYSBPUk0gc2V0dXAsIHNjaGVtYSBkZXNpZ24sIGNsaWVudCBBUEksIGFuZCBtaWdyYXRpb25zXCIsXG4gICAgcmVwbzogXCJwcmlzbWEvc2tpbGxzXCIsXG4gICAgc2tpbGxzOiBbXG4gICAgICBcInByaXNtYS1kYXRhYmFzZS1zZXR1cFwiLFxuICAgICAgXCJwcmlzbWEtY2xpZW50LWFwaVwiLFxuICAgICAgXCJwcmlzbWEtY2xpXCIsXG4gICAgXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJwcmlzbWEvc2NoZW1hLnByaXNtYVwiXSxcbiAgfSxcbiAge1xuICAgIGxhYmVsOiBcIlN1cGFiYXNlICYgUG9zdGdyZXNcIixcbiAgICBkZXNjcmlwdGlvbjogXCJTdXBhYmFzZSBwcm9qZWN0IHNldHVwLCBhdXRoLCBQb3N0Z3JlcyBiZXN0IHByYWN0aWNlcywgYW5kIEZpcmVzdG9yZVwiLFxuICAgIHJlcG86IFwic3VwYWJhc2UvYWdlbnQtc2tpbGxzXCIsXG4gICAgc2tpbGxzOiBbXCJzdXBhYmFzZS1wb3N0Z3Jlcy1iZXN0LXByYWN0aWNlc1wiXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJzdXBhYmFzZS9jb25maWcudG9tbFwiXSxcbiAgfSxcbiAge1xuICAgIGxhYmVsOiBcIlBvc3RncmVTUUwgRGVzaWduXCIsXG4gICAgZGVzY3JpcHRpb246IFwiUG9zdGdyZVNRTCB0YWJsZSBkZXNpZ24sIGluZGV4aW5nIHN0cmF0ZWdpZXMsIGFuZCBxdWVyeSBvcHRpbWl6YXRpb25cIixcbiAgICByZXBvOiBcIndzaG9ic29uL2FnZW50c1wiLFxuICAgIHNraWxsczogW1wicG9zdGdyZXNxbC10YWJsZS1kZXNpZ25cIl0sXG4gICAgbWF0Y2hGaWxlczogW1wic3VwYWJhc2UvY29uZmlnLnRvbWxcIiwgXCIqLnNxbFwiXSxcbiAgfSxcbiAge1xuICAgIGxhYmVsOiBcIlNRTCBPcHRpbWl6YXRpb24gJiBSZXZpZXdcIixcbiAgICBkZXNjcmlwdGlvbjogXCJVbml2ZXJzYWwgU1FMIHBlcmZvcm1hbmNlIG9wdGltaXphdGlvbiwgc2VjdXJpdHkgKGluamVjdGlvbiBwcmV2ZW50aW9uKSwgYW5kIGNvZGUgcmV2aWV3XCIsXG4gICAgcmVwbzogXCJnaXRodWIvYXdlc29tZS1jb3BpbG90XCIsXG4gICAgc2tpbGxzOiBbXCJzcWwtb3B0aW1pemF0aW9uXCIsIFwic3FsLWNvZGUtcmV2aWV3XCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcbiAgICAgIFwiKi5zcWxcIixcbiAgICAgIFwiKi5zcWxpdGVcIixcbiAgICAgIFwicHJpc21hL3NjaGVtYS5wcmlzbWFcIixcbiAgICAgIFwic3VwYWJhc2UvY29uZmlnLnRvbWxcIixcbiAgICAgIFwiZHJpenpsZS5jb25maWcudHNcIixcbiAgICAgIFwiZHJpenpsZS5jb25maWcuanNcIixcbiAgICBdLFxuICB9LFxuICB7XG4gICAgbGFiZWw6IFwiUmVkaXNcIixcbiAgICBkZXNjcmlwdGlvbjogXCJSZWRpcyBkZXZlbG9wbWVudCBwYXR0ZXJucyBhbmQgYmVzdCBwcmFjdGljZXNcIixcbiAgICByZXBvOiBcInJlZGlzL2FnZW50LXNraWxsc1wiLFxuICAgIHNraWxsczogW1wicmVkaXMtZGV2ZWxvcG1lbnRcIl0sXG4gICAgbWF0Y2hGaWxlczogW1wicmVkaXMuY29uZlwiXSxcbiAgfSxcbiAgLy8gXHUyNTAwXHUyNTAwIENsb3VkIFBsYXRmb3JtcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIkZpcmViYXNlXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRmlyZWJhc2Ugc2V0dXAsIGF1dGgsIEZpcmVzdG9yZSwgaG9zdGluZywgYW5kIEFJIExvZ2ljXCIsXG4gICAgcmVwbzogXCJmaXJlYmFzZS9hZ2VudC1za2lsbHNcIixcbiAgICBza2lsbHM6IFtcbiAgICAgIFwiZmlyZWJhc2UtYmFzaWNzXCIsXG4gICAgICBcImZpcmViYXNlLWF1dGgtYmFzaWNzXCIsXG4gICAgICBcImZpcmViYXNlLWZpcmVzdG9yZS1iYXNpY3NcIixcbiAgICAgIFwiZmlyZWJhc2UtaG9zdGluZy1iYXNpY3NcIixcbiAgICAgIFwiZmlyZWJhc2UtYWktbG9naWNcIixcbiAgICBdLFxuICAgIG1hdGNoRmlsZXM6IFtcImZpcmViYXNlLmpzb25cIl0sXG4gIH0sXG4gIHtcbiAgICBsYWJlbDogXCJBenVyZVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkF6dXJlIGRlcGxveW1lbnQsIEFJIHNlcnZpY2VzLCBzdG9yYWdlLCBjb3N0IG9wdGltaXphdGlvbiwgYW5kIGRpYWdub3N0aWNzXCIsXG4gICAgcmVwbzogXCJtaWNyb3NvZnQvZ2l0aHViLWNvcGlsb3QtZm9yLWF6dXJlXCIsXG4gICAgc2tpbGxzOiBbXG4gICAgICBcImF6dXJlLWRlcGxveVwiLFxuICAgICAgXCJhenVyZS1haVwiLFxuICAgICAgXCJhenVyZS1zdG9yYWdlXCIsXG4gICAgICBcImF6dXJlLWNvc3Qtb3B0aW1pemF0aW9uXCIsXG4gICAgICBcImF6dXJlLWRpYWdub3N0aWNzXCIsXG4gICAgXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJhenVyZS1waXBlbGluZXMueW1sXCJdLFxuICB9LFxuICB7XG4gICAgbGFiZWw6IFwiQVdTXCIsXG4gICAgZGVzY3JpcHRpb246IFwiQVdTIGRlcGxveW1lbnQsIExhbWJkYSwgYW5kIHNlcnZlcmxlc3MgcGF0dGVybnNcIixcbiAgICByZXBvOiBcImF3c2xhYnMvYWdlbnQtcGx1Z2luc1wiLFxuICAgIHNraWxsczogW1wiZGVwbG95XCIsIFwiYXdzLWxhbWJkYVwiLCBcImF3cy1zZXJ2ZXJsZXNzLWRlcGxveW1lbnRcIl0sXG4gICAgbWF0Y2hGaWxlczogW1wiY2RrLmpzb25cIiwgXCJzYW1jb25maWcudG9tbFwiLCBcInNlcnZlcmxlc3MueW1sXCIsIFwic2VydmVybGVzcy55YW1sXCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgQ29udGFpbmVyIC8gRGV2T3BzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB7XG4gICAgbGFiZWw6IFwiRG9ja2VyXCIsXG4gICAgZGVzY3JpcHRpb246IFwiTXVsdGktc3RhZ2UgRG9ja2VyZmlsZXMsIGxheWVyIG9wdGltaXphdGlvbiwgYW5kIHNlY3VyaXR5IGhhcmRlbmluZ1wiLFxuICAgIHJlcG86IFwiZ2l0aHViL2F3ZXNvbWUtY29waWxvdFwiLFxuICAgIHNraWxsczogW1wibXVsdGktc3RhZ2UtZG9ja2VyZmlsZVwiXSxcbiAgICBtYXRjaEZpbGVzOiBbXCJEb2NrZXJmaWxlXCIsIFwiZG9ja2VyLWNvbXBvc2UueW1sXCIsIFwiZG9ja2VyLWNvbXBvc2UueWFtbFwiXSxcbiAgfSxcbiAgLy8gXHUyNTAwXHUyNTAwIEluZnJhc3RydWN0dXJlIGFzIENvZGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHtcbiAgICBsYWJlbDogXCJUZXJyYWZvcm1cIixcbiAgICBkZXNjcmlwdGlvbjogXCJUZXJyYWZvcm0gc3R5bGUgZ3VpZGUsIHRlc3RpbmcsIGFuZCBzdGFjayBwYXR0ZXJuc1wiLFxuICAgIHJlcG86IFwiaGFzaGljb3JwL2FnZW50LXNraWxsc1wiLFxuICAgIHNraWxsczogW1widGVycmFmb3JtLXN0eWxlLWd1aWRlXCIsIFwidGVycmFmb3JtLXRlc3RcIiwgXCJ0ZXJyYWZvcm0tc3RhY2tzXCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcIm1haW4udGZcIl0sXG4gIH0sXG4gIC8vIFx1MjUwMFx1MjUwMCBBbmRyb2lkICh3c2hvYnNvbi9hZ2VudHMgXHUyMDE0IDdLIGluc3RhbGxzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIkFuZHJvaWRcIixcbiAgICBkZXNjcmlwdGlvbjogXCJBbmRyb2lkIGFwcCBkZXNpZ24gZm9sbG93aW5nIE1hdGVyaWFsIERlc2lnbiAzIGd1aWRlbGluZXNcIixcbiAgICByZXBvOiBcIndzaG9ic29uL2FnZW50c1wiLFxuICAgIHNraWxsczogW1wibW9iaWxlLWFuZHJvaWQtZGVzaWduXCJdLFxuICAgIG1hdGNoRmlsZXM6IFtcImFwcC9idWlsZC5ncmFkbGVcIiwgXCJhcHAvYnVpbGQuZ3JhZGxlLmt0c1wiXSxcbiAgfSxcbiAgLy8gXHUyNTAwXHUyNTAwIEt1YmVybmV0ZXMgKHdzaG9ic29uL2FnZW50cyBcdTIwMTQgNCBza2lsbHMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB7XG4gICAgbGFiZWw6IFwiS3ViZXJuZXRlc1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIks4cyBtYW5pZmVzdHMsIEhlbG0gY2hhcnRzLCBHaXRPcHMgd29ya2Zsb3dzLCBhbmQgc2VjdXJpdHkgcG9saWNpZXNcIixcbiAgICByZXBvOiBcIndzaG9ic29uL2FnZW50c1wiLFxuICAgIHNraWxsczogW1xuICAgICAgXCJrOHMtbWFuaWZlc3QtZ2VuZXJhdG9yXCIsXG4gICAgICBcImhlbG0tY2hhcnQtc2NhZmZvbGRpbmdcIixcbiAgICAgIFwiZ2l0b3BzLXdvcmtmbG93XCIsXG4gICAgICBcIms4cy1zZWN1cml0eS1wb2xpY2llc1wiLFxuICAgIF0sXG4gICAgbWF0Y2hGaWxlczogW1wiQ2hhcnQueWFtbFwiLCBcImt1c3RvbWl6YXRpb24ueWFtbFwiXSxcbiAgfSxcbiAgLy8gXHUyNTAwXHUyNTAwIENJL0NEICh3c2hvYnNvbi9hZ2VudHMgXHUyMDE0IDMgc2tpbGxzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIkNJL0NEIEF1dG9tYXRpb25cIixcbiAgICBkZXNjcmlwdGlvbjogXCJQaXBlbGluZSBkZXNpZ24sIEdpdEh1YiBBY3Rpb25zIHdvcmtmbG93cywgYW5kIHNlY3JldHMgbWFuYWdlbWVudFwiLFxuICAgIHJlcG86IFwid3Nob2Jzb24vYWdlbnRzXCIsXG4gICAgc2tpbGxzOiBbXG4gICAgICBcImRlcGxveW1lbnQtcGlwZWxpbmUtZGVzaWduXCIsXG4gICAgICBcImdpdGh1Yi1hY3Rpb25zLXRlbXBsYXRlc1wiLFxuICAgICAgXCJzZWNyZXRzLW1hbmFnZW1lbnRcIixcbiAgICBdLFxuICAgIG1hdGNoRmlsZXM6IFtcIi5naXRodWIvd29ya2Zsb3dzXCJdLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgQmxvY2tjaGFpbiAvIFdlYjMgKHdzaG9ic29uL2FnZW50cyBcdTIwMTQgMyBza2lsbHMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB7XG4gICAgbGFiZWw6IFwiQmxvY2tjaGFpbiAmIFdlYjNcIixcbiAgICBkZXNjcmlwdGlvbjogXCJTb2xpZGl0eSBzZWN1cml0eSwgRGVGaSBwcm90b2NvbHMsIGFuZCBzbWFydCBjb250cmFjdCB0ZXN0aW5nXCIsXG4gICAgcmVwbzogXCJ3c2hvYnNvbi9hZ2VudHNcIixcbiAgICBza2lsbHM6IFtcInNvbGlkaXR5LXNlY3VyaXR5XCIsIFwiZGVmaS1wcm90b2NvbC10ZW1wbGF0ZXNcIiwgXCJ3ZWIzLXRlc3RpbmdcIl0sXG4gICAgbWF0Y2hGaWxlczogW1wiaGFyZGhhdC5jb25maWcuanNcIiwgXCJoYXJkaGF0LmNvbmZpZy50c1wiLCBcImZvdW5kcnkudG9tbFwiXSxcbiAgfSxcbiAgLy8gXHUyNTAwXHUyNTAwIERhdGEgRW5naW5lZXJpbmcgKHdzaG9ic29uL2FnZW50cyBcdTIwMTQgNCBza2lsbHMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB7XG4gICAgbGFiZWw6IFwiRGF0YSBFbmdpbmVlcmluZ1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcImRidCB0cmFuc2Zvcm1hdGlvbnMsIEFpcmZsb3cgREFHcywgU3Bhcmsgb3B0aW1pemF0aW9uLCBhbmQgZGF0YSBxdWFsaXR5XCIsXG4gICAgcmVwbzogXCJ3c2hvYnNvbi9hZ2VudHNcIixcbiAgICBza2lsbHM6IFtcbiAgICAgIFwiZGJ0LXRyYW5zZm9ybWF0aW9uLXBhdHRlcm5zXCIsXG4gICAgICBcImFpcmZsb3ctZGFnLXBhdHRlcm5zXCIsXG4gICAgICBcInNwYXJrLW9wdGltaXphdGlvblwiLFxuICAgICAgXCJkYXRhLXF1YWxpdHktZnJhbWV3b3Jrc1wiLFxuICAgIF0sXG4gICAgbWF0Y2hGaWxlczogW1wiZGJ0X3Byb2plY3QueW1sXCIsIFwiYWlyZmxvdy5jZmdcIl0sXG4gIH0sXG4gIC8vIFx1MjUwMFx1MjUwMCBHYW1lIERldmVsb3BtZW50IFx1MjAxNCBVbml0eSAod3Nob2Jzb24vYWdlbnRzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIlVuaXR5XCIsXG4gICAgZGVzY3JpcHRpb246IFwiVW5pdHkgRUNTIHBhdHRlcm5zIGZvciBoaWdoLXBlcmZvcm1hbmNlIGdhbWUgc3lzdGVtc1wiLFxuICAgIHJlcG86IFwid3Nob2Jzb24vYWdlbnRzXCIsXG4gICAgc2tpbGxzOiBbXCJ1bml0eS1lY3MtcGF0dGVybnNcIl0sXG4gICAgbWF0Y2hGaWxlczogW1wiUHJvamVjdFNldHRpbmdzL1Byb2plY3RWZXJzaW9uLnR4dFwiXSxcbiAgfSxcbiAgLy8gXHUyNTAwXHUyNTAwIEdhbWUgRGV2ZWxvcG1lbnQgXHUyMDE0IEdvZG90ICh3c2hvYnNvbi9hZ2VudHMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB7XG4gICAgbGFiZWw6IFwiR29kb3RcIixcbiAgICBkZXNjcmlwdGlvbjogXCJHb2RvdCBHRFNjcmlwdCBiZXN0IHByYWN0aWNlcyBhbmQgc2NlbmUgY29tcG9zaXRpb25cIixcbiAgICByZXBvOiBcIndzaG9ic29uL2FnZW50c1wiLFxuICAgIHNraWxsczogW1wiZ29kb3QtZ2RzY3JpcHQtcGF0dGVybnNcIl0sXG4gICAgbWF0Y2hGaWxlczogW1wicHJvamVjdC5nb2RvdFwiXSxcbiAgfSxcbiAgLy8gXHUyNTAwXHUyNTAwIEVzc2VudGlhbCAoYWxsIHByb2plY3RzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIlNraWxsIERpc2NvdmVyeVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkZpbmQgYW5kIGluc3RhbGwgbmV3IGFnZW50IHNraWxscyBmcm9tIHRoZSBlY29zeXN0ZW1cIixcbiAgICByZXBvOiBcInZlcmNlbC1sYWJzL3NraWxsc1wiLFxuICAgIHNraWxsczogW1wiZmluZC1za2lsbHNcIl0sXG4gICAgbWF0Y2hBbHdheXM6IHRydWUsXG4gIH0sXG4gIHtcbiAgICBsYWJlbDogXCJTa2lsbCBBdXRob3JpbmdcIixcbiAgICBkZXNjcmlwdGlvbjogXCJDcmVhdGUsIGF1ZGl0LCBhbmQgcmVmaW5lIFNLSUxMLm1kIGZpbGVzXCIsXG4gICAgcmVwbzogXCJhbnRocm9waWNzL3NraWxsc1wiLFxuICAgIHNraWxsczogW1wic2tpbGwtY3JlYXRvclwiXSxcbiAgICBtYXRjaEFsd2F5czogdHJ1ZSxcbiAgfSxcbiAge1xuICAgIGxhYmVsOiBcIkJyb3dzZXIgQXV0b21hdGlvblwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkJyb3dzZXIgYXV0b21hdGlvbiBmb3Igd2ViIHNjcmFwaW5nLCB0ZXN0aW5nLCBhbmQgaW50ZXJhY3Rpb25cIixcbiAgICByZXBvOiBcInZlcmNlbC1sYWJzL2FnZW50LWJyb3dzZXJcIixcbiAgICBza2lsbHM6IFtcImFnZW50LWJyb3dzZXJcIl0sXG4gICAgbWF0Y2hBbHdheXM6IHRydWUsXG4gIH0sXG4gIC8vIFx1MjUwMFx1MjUwMCBHZW5lcmFsIFRvb2xpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHtcbiAgICBsYWJlbDogXCJEb2N1bWVudCBIYW5kbGluZ1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlBERiwgRE9DWCwgWExTWCwgUFBUWCBjcmVhdGlvbiBhbmQgbWFuaXB1bGF0aW9uXCIsXG4gICAgcmVwbzogXCJhbnRocm9waWNzL3NraWxsc1wiLFxuICAgIHNraWxsczogW1wicGRmXCIsIFwiZG9jeFwiLCBcInhsc3hcIiwgXCJwcHR4XCJdLFxuICAgIG1hdGNoQWx3YXlzOiB0cnVlLFxuICB9LFxuICAvLyBcdTI1MDBcdTI1MDAgQ29kZSBRdWFsaXR5ICh3c2hvYnNvbi9hZ2VudHMgXHUyMDE0IG1hdGNoQWx3YXlzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAge1xuICAgIGxhYmVsOiBcIkNvZGUgUmV2aWV3ICYgUXVhbGl0eVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNvZGUgcmV2aWV3IGV4Y2VsbGVuY2UgYW5kIGVycm9yIGhhbmRsaW5nIHBhdHRlcm5zXCIsXG4gICAgcmVwbzogXCJ3c2hvYnNvbi9hZ2VudHNcIixcbiAgICBza2lsbHM6IFtcImNvZGUtcmV2aWV3LWV4Y2VsbGVuY2VcIiwgXCJlcnJvci1oYW5kbGluZy1wYXR0ZXJuc1wiXSxcbiAgICBtYXRjaEFsd2F5czogdHJ1ZSxcbiAgfSxcbiAge1xuICAgIGxhYmVsOiBcIkdpdCBBZHZhbmNlZCBXb3JrZmxvd3NcIixcbiAgICBkZXNjcmlwdGlvbjogXCJBZHZhbmNlZCBHaXQgcmViYXNpbmcsIGNoZXJyeS1waWNraW5nLCBiaXNlY3QsIHdvcmt0cmVlcywgYW5kIHJlZmxvZ1wiLFxuICAgIHJlcG86IFwid3Nob2Jzb24vYWdlbnRzXCIsXG4gICAgc2tpbGxzOiBbXCJnaXQtYWR2YW5jZWQtd29ya2Zsb3dzXCJdLFxuICAgIG1hdGNoQWx3YXlzOiB0cnVlLFxuICB9LFxuXTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEdyZWVuZmllbGQgVGVjaCBTdGFjayBDaG9pY2VzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFRlY2ggc3RhY2sgXHUyMTkyIHBhY2sgbWFwcGluZ3MgZm9yIHByb2dyYW1tYXRpYyB1c2UuXG4gKlxuICogTk9UIHNob3duIGRpcmVjdGx5IHRvIHVzZXJzIGR1cmluZyBpbml0IChncmVlbmZpZWxkIGluc3RhbGxzIGVzc2VudGlhbHNcbiAqIG9ubHkgYW5kIGRlZmVycyBzdGFjay1zcGVjaWZpYyBza2lsbHMpLiAgVGhlc2UgbWFwcGluZ3MgYXJlIGF2YWlsYWJsZSBmb3I6XG4gKiAgIDEuIFRoZSBMTE0gdG8gaW5zdGFsbCBza2lsbHMgYWZ0ZXIgZXN0YWJsaXNoaW5nIGEgZGVzaWduXG4gKiAgIDIuIFRoZSBgL2dzZCBza2lsbHNgIGNvbW1hbmQgKGV4cGxpY2l0IHVzZXIgcmVxdWVzdClcbiAqICAgMy4gUmUtcnVubmluZyBicm93bmZpZWxkIGRldGVjdGlvbiBhZnRlciBwcm9qZWN0IGZpbGVzIGFyZSBjcmVhdGVkXG4gKi9cbmV4cG9ydCBjb25zdCBHUkVFTkZJRUxEX1NUQUNLUzogQXJyYXk8e1xuICBpZDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICBwYWNrczogc3RyaW5nW107XG59PiA9IFtcbiAge1xuICAgIGlkOiBcImlvc1wiLFxuICAgIGxhYmVsOiBcImlPUyBBcHBcIixcbiAgICBkZXNjcmlwdGlvbjogXCJGdWxsIGlPUyBkZXZlbG9wbWVudCBcdTIwMTQgU3dpZnRVSSwgU3dpZnQsIGFuZCBhbGwgaU9TIGZyYW1ld29ya3NcIixcbiAgICBwYWNrczogW1xuICAgICAgXCJTd2lmdFVJXCIsXG4gICAgICBcIlN3aWZ0IENvcmVcIixcbiAgICAgIFwiaU9TIEFwcCBGcmFtZXdvcmtzXCIsXG4gICAgICBcImlPUyBEYXRhIEZyYW1ld29ya3NcIixcbiAgICAgIFwiaU9TIEFJICYgTUxcIixcbiAgICAgIFwiaU9TIEVuZ2luZWVyaW5nXCIsXG4gICAgICBcImlPUyBIYXJkd2FyZVwiLFxuICAgICAgXCJpT1MgUGxhdGZvcm1cIixcbiAgICBdLFxuICB9LFxuICB7XG4gICAgaWQ6IFwic3dpZnRcIixcbiAgICBsYWJlbDogXCJTd2lmdCAobm9uLWlPUylcIixcbiAgICBkZXNjcmlwdGlvbjogXCJTd2lmdCBwYWNrYWdlcywgc2VydmVyLXNpZGUgU3dpZnQsIENMSSB0b29scywgU3dpZnRVSSB3aXRob3V0IGlPU1wiLFxuICAgIHBhY2tzOiBbXCJTd2lmdFVJXCIsIFwiU3dpZnQgQ29yZVwiXSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInJlYWN0LXdlYlwiLFxuICAgIGxhYmVsOiBcIlJlYWN0IFdlYlwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlJlYWN0LCBOZXh0LmpzLCBzaGFkY24vdWksIHdlYiBmcm9udGVuZFwiLFxuICAgIHBhY2tzOiBbXCJSZWFjdCAmIFdlYiBGcm9udGVuZFwiLCBcIlR5cGVTY3JpcHQgJiBKUyBEZXZlbG9wbWVudFwiLCBcIlJlYWN0IFN0YXRlICYgUGF0dGVybnNcIiwgXCJUYWlsd2luZCBDU1NcIiwgXCJzaGFkY24vdWlcIiwgXCJGcm9udGVuZCBEZXNpZ24gJiBVWFwiXSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInJlYWN0LW5hdGl2ZVwiLFxuICAgIGxhYmVsOiBcIlJlYWN0IE5hdGl2ZVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkNyb3NzLXBsYXRmb3JtIG1vYmlsZSB3aXRoIFJlYWN0IE5hdGl2ZVwiLFxuICAgIHBhY2tzOiBbXCJSZWFjdCBOYXRpdmVcIiwgXCJSZWFjdCBOYXRpdmUgQXJjaGl0ZWN0dXJlXCIsIFwiUmVhY3QgJiBXZWIgRnJvbnRlbmRcIiwgXCJUeXBlU2NyaXB0ICYgSlMgRGV2ZWxvcG1lbnRcIl0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJmdWxsc3RhY2stanNcIixcbiAgICBsYWJlbDogXCJGdWxsLVN0YWNrIEphdmFTY3JpcHQvVHlwZVNjcmlwdFwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIk5vZGUuanMgYmFja2VuZCArIFJlYWN0IGZyb250ZW5kXCIsXG4gICAgcGFja3M6IFtcIlJlYWN0ICYgV2ViIEZyb250ZW5kXCIsIFwiVHlwZVNjcmlwdCAmIEpTIERldmVsb3BtZW50XCIsIFwiUmVhY3QgU3RhdGUgJiBQYXR0ZXJuc1wiLCBcIlRhaWx3aW5kIENTU1wiLCBcInNoYWRjbi91aVwiLCBcIkZyb250ZW5kIERlc2lnbiAmIFVYXCIsIFwiUHJpc21hXCJdLFxuICB9LFxuICB7XG4gICAgaWQ6IFwicnVzdFwiLFxuICAgIGxhYmVsOiBcIlJ1c3RcIixcbiAgICBkZXNjcmlwdGlvbjogXCJTeXN0ZW1zIHByb2dyYW1taW5nIHdpdGggUnVzdFwiLFxuICAgIHBhY2tzOiBbXCJSdXN0XCIsIFwiUnVzdCBBc3luYyBQYXR0ZXJuc1wiXSxcbiAgfSxcbiAge1xuICAgIGlkOiBcInB5dGhvblwiLFxuICAgIGxhYmVsOiBcIlB5dGhvblwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlB5dGhvbiBhcHBsaWNhdGlvbnMsIHNjcmlwdHMsIG9yIE1MXCIsXG4gICAgcGFja3M6IFtcIlB5dGhvblwiLCBcIlB5dGhvbiBBZHZhbmNlZFwiXSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImdvXCIsXG4gICAgbGFiZWw6IFwiR29cIixcbiAgICBkZXNjcmlwdGlvbjogXCJHbyBzZXJ2aWNlcyBhbmQgQ0xJc1wiLFxuICAgIHBhY2tzOiBbXCJHb1wiLCBcIkdvIENvbmN1cnJlbmN5IFBhdHRlcm5zXCJdLFxuICB9LFxuICB7XG4gICAgaWQ6IFwiZmlyZWJhc2VcIixcbiAgICBsYWJlbDogXCJGaXJlYmFzZVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkZpcmViYXNlIGJhY2tlbmQgXHUyMDE0IGF1dGgsIEZpcmVzdG9yZSwgaG9zdGluZywgQUlcIixcbiAgICBwYWNrczogW1wiRmlyZWJhc2VcIl0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJhd3NcIixcbiAgICBsYWJlbDogXCJBV1NcIixcbiAgICBkZXNjcmlwdGlvbjogXCJBV1MgZGVwbG95bWVudCwgTGFtYmRhLCBzZXJ2ZXJsZXNzXCIsXG4gICAgcGFja3M6IFtcIkFXU1wiXSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImF6dXJlXCIsXG4gICAgbGFiZWw6IFwiQXp1cmVcIixcbiAgICBkZXNjcmlwdGlvbjogXCJBenVyZSBkZXBsb3ltZW50LCBBSSwgc3RvcmFnZSwgZGlhZ25vc3RpY3NcIixcbiAgICBwYWNrczogW1wiQXp1cmVcIl0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJhbmd1bGFyXCIsXG4gICAgbGFiZWw6IFwiQW5ndWxhclwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkFuZ3VsYXIgY29tcG9uZW50cywgc2lnbmFscywgZm9ybXMsIHJvdXRpbmdcIixcbiAgICBwYWNrczogW1wiQW5ndWxhclwiLCBcIkFuZ3VsYXIgTWlncmF0aW9uXCIsIFwiRnJvbnRlbmQgRGVzaWduICYgVVhcIl0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJ2dWVcIixcbiAgICBsYWJlbDogXCJWdWUuanMgLyBOdXh0XCIsXG4gICAgZGVzY3JpcHRpb246IFwiVnVlLmpzIHdpdGggUGluaWEsIFZ1ZSBSb3V0ZXIsIGFuZCB0ZXN0aW5nXCIsXG4gICAgcGFja3M6IFtcIlZ1ZS5qc1wiLCBcIkZyb250ZW5kIERlc2lnbiAmIFVYXCJdLFxuICB9LFxuICB7XG4gICAgaWQ6IFwic3ZlbHRlXCIsXG4gICAgbGFiZWw6IFwiU3ZlbHRlIC8gU3ZlbHRlS2l0XCIsXG4gICAgZGVzY3JpcHRpb246IFwiU3ZlbHRlIDUgYW5kIFN2ZWx0ZUtpdCBwYXR0ZXJuc1wiLFxuICAgIHBhY2tzOiBbXCJTdmVsdGVcIiwgXCJUYWlsd2luZCBDU1NcIiwgXCJGcm9udGVuZCBEZXNpZ24gJiBVWFwiXSxcbiAgfSxcbiAge1xuICAgIGlkOiBcIm5leHRqc1wiLFxuICAgIGxhYmVsOiBcIk5leHQuanNcIixcbiAgICBkZXNjcmlwdGlvbjogXCJOZXh0LmpzIGFwcCByb3V0ZXIsIFJlYWN0LCBhbmQgVmVyY2VsIGRlcGxveW1lbnRcIixcbiAgICBwYWNrczogW1wiTmV4dC5qc1wiLCBcIk5leHQuanMgQXBwIFJvdXRlciBQYXR0ZXJuc1wiLCBcIlJlYWN0ICYgV2ViIEZyb250ZW5kXCIsIFwiVHlwZVNjcmlwdCAmIEpTIERldmVsb3BtZW50XCIsIFwiVGFpbHdpbmQgQ1NTXCIsIFwic2hhZGNuL3VpXCJdLFxuICB9LFxuICB7XG4gICAgaWQ6IFwiZmx1dHRlclwiLFxuICAgIGxhYmVsOiBcIkZsdXR0ZXJcIixcbiAgICBkZXNjcmlwdGlvbjogXCJDcm9zcy1wbGF0Zm9ybSBGbHV0dGVyL0RhcnQgZGV2ZWxvcG1lbnRcIixcbiAgICBwYWNrczogW1wiRmx1dHRlclwiXSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImphdmFcIixcbiAgICBsYWJlbDogXCJKYXZhIC8gU3ByaW5nIEJvb3RcIixcbiAgICBkZXNjcmlwdGlvbjogXCJTcHJpbmcgQm9vdCBBUElzLCBKUEEsIGFuZCB0ZXN0aW5nXCIsXG4gICAgcGFja3M6IFtcIkphdmEgJiBTcHJpbmcgQm9vdFwiXSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImRvdG5ldFwiLFxuICAgIGxhYmVsOiBcIi5ORVQgLyBDI1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkFTUC5ORVQgQ29yZSwgRW50aXR5IEZyYW1ld29yaywgYW5kIGRlc2lnbiBwYXR0ZXJuc1wiLFxuICAgIHBhY2tzOiBbXCIuTkVUICYgQyNcIiwgXCIuTkVUIEJhY2tlbmQgUGF0dGVybnNcIl0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJwaHBcIixcbiAgICBsYWJlbDogXCJQSFAgLyBMYXJhdmVsXCIsXG4gICAgZGVzY3JpcHRpb246IFwiTGFyYXZlbCBwYXR0ZXJucyBhbmQgUEhQIGJlc3QgcHJhY3RpY2VzXCIsXG4gICAgcGFja3M6IFtcIlBIUCAmIExhcmF2ZWxcIl0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJkamFuZ29cIixcbiAgICBsYWJlbDogXCJEamFuZ29cIixcbiAgICBkZXNjcmlwdGlvbjogXCJEamFuZ28gbW9kZWxzLCB2aWV3cywgbWlkZGxld2FyZSwgYW5kIENlbGVyeVwiLFxuICAgIHBhY2tzOiBbXCJEamFuZ29cIiwgXCJQeXRob25cIiwgXCJQeXRob24gQWR2YW5jZWRcIl0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJmYXN0YXBpXCIsXG4gICAgbGFiZWw6IFwiRmFzdEFQSVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkZhc3RBUEkgd2ViIEFQSXMgd2l0aCBhc3luYyBwYXR0ZXJuc1wiLFxuICAgIHBhY2tzOiBbXCJGYXN0QVBJXCIsIFwiUHl0aG9uXCIsIFwiUHl0aG9uIEFkdmFuY2VkXCJdLFxuICB9LFxuICB7XG4gICAgaWQ6IFwiYW5kcm9pZFwiLFxuICAgIGxhYmVsOiBcIkFuZHJvaWQgLyBLb3RsaW5cIixcbiAgICBkZXNjcmlwdGlvbjogXCJBbmRyb2lkIGFwcCBkZXZlbG9wbWVudCB3aXRoIE1hdGVyaWFsIERlc2lnbiAzXCIsXG4gICAgcGFja3M6IFtcIkFuZHJvaWRcIl0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJrdWJlcm5ldGVzXCIsXG4gICAgbGFiZWw6IFwiS3ViZXJuZXRlc1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkt1YmVybmV0ZXMgbWFuaWZlc3RzLCBIZWxtIGNoYXJ0cywgYW5kIEdpdE9wc1wiLFxuICAgIHBhY2tzOiBbXCJLdWJlcm5ldGVzXCIsIFwiRG9ja2VyXCJdLFxuICB9LFxuICB7XG4gICAgaWQ6IFwiYmxvY2tjaGFpblwiLFxuICAgIGxhYmVsOiBcIkJsb2NrY2hhaW4gLyBXZWIzXCIsXG4gICAgZGVzY3JpcHRpb246IFwiU29saWRpdHksIERlRmkgcHJvdG9jb2xzLCBhbmQgc21hcnQgY29udHJhY3QgdGVzdGluZ1wiLFxuICAgIHBhY2tzOiBbXCJCbG9ja2NoYWluICYgV2ViM1wiXSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImRhdGEtZW5naW5lZXJpbmdcIixcbiAgICBsYWJlbDogXCJEYXRhIEVuZ2luZWVyaW5nXCIsXG4gICAgZGVzY3JpcHRpb246IFwiZGJ0LCBBaXJmbG93LCBTcGFyaywgYW5kIGRhdGEgcXVhbGl0eVwiLFxuICAgIHBhY2tzOiBbXCJEYXRhIEVuZ2luZWVyaW5nXCIsIFwiUHl0aG9uXCIsIFwiUHl0aG9uIEFkdmFuY2VkXCJdLFxuICB9LFxuICB7XG4gICAgaWQ6IFwidW5pdHlcIixcbiAgICBsYWJlbDogXCJVbml0eVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlVuaXR5IGdhbWUgZGV2ZWxvcG1lbnQgd2l0aCBFQ1MgcGF0dGVybnNcIixcbiAgICBwYWNrczogW1wiVW5pdHlcIl0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJnb2RvdFwiLFxuICAgIGxhYmVsOiBcIkdvZG90XCIsXG4gICAgZGVzY3JpcHRpb246IFwiR29kb3QgZ2FtZSBkZXZlbG9wbWVudCB3aXRoIEdEU2NyaXB0XCIsXG4gICAgcGFja3M6IFtcIkdvZG90XCJdLFxuICB9LFxuICB7XG4gICAgaWQ6IFwib3RoZXJcIixcbiAgICBsYWJlbDogXCJPdGhlciAvIFNraXBcIixcbiAgICBkZXNjcmlwdGlvbjogXCJJbnN0YWxsIHNraWxscyBsYXRlciB3aXRoIG5weCBza2lsbHMgYWRkXCIsXG4gICAgcGFja3M6IFtdLFxuICB9LFxuXTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERldGVjdGlvbiBcdTIxOTIgUGFjayBNYXRjaGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBNYXRjaCBwcm9qZWN0IHNpZ25hbHMgdG8gcmVsZXZhbnQgc2tpbGwgcGFja3MuXG4gKiBSZXR1cm5zIHBhY2tzIGluIGNhdGFsb2cgb3JkZXIgKG5vdCBzb3J0ZWQgYnkgbWF0Y2ggdHlwZSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXRjaFBhY2tzRm9yUHJvamVjdChzaWduYWxzOiBQcm9qZWN0U2lnbmFscyk6IFNraWxsUGFja1tdIHtcbiAgY29uc3QgbWF0Y2hlZCA9IG5ldyBTZXQ8U2tpbGxQYWNrPigpO1xuXG4gIGZvciAoY29uc3QgcGFjayBvZiBTS0lMTF9DQVRBTE9HKSB7XG4gICAgLy8gTGFuZ3VhZ2UgbWF0Y2hcbiAgICBpZiAocGFjay5tYXRjaExhbmd1YWdlcyAmJiBzaWduYWxzLnByaW1hcnlMYW5ndWFnZSkge1xuICAgICAgaWYgKHBhY2subWF0Y2hMYW5ndWFnZXMuaW5jbHVkZXMoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UpKSB7XG4gICAgICAgIG1hdGNoZWQuYWRkKHBhY2spO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBGaWxlIG1hdGNoXG4gICAgaWYgKHBhY2subWF0Y2hGaWxlcykge1xuICAgICAgZm9yIChjb25zdCBmaWxlIG9mIHBhY2subWF0Y2hGaWxlcykge1xuICAgICAgICBpZiAoc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKGZpbGUpKSB7XG4gICAgICAgICAgbWF0Y2hlZC5hZGQocGFjayk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBYY29kZSBwbGF0Zm9ybSBtYXRjaCAoZS5nLiBpT1MgcGFja3Mgb25seSB3aGVuIFNES1JPT1QgPSBpcGhvbmVvcylcbiAgICBpZiAocGFjay5tYXRjaFhjb2RlUGxhdGZvcm1zICYmIHNpZ25hbHMueGNvZGVQbGF0Zm9ybXMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgaGFzTWF0Y2ggPSBwYWNrLm1hdGNoWGNvZGVQbGF0Zm9ybXMuc29tZSgocCkgPT4gc2lnbmFscy54Y29kZVBsYXRmb3Jtcy5pbmNsdWRlcyhwKSk7XG4gICAgICBpZiAoaGFzTWF0Y2gpIG1hdGNoZWQuYWRkKHBhY2spO1xuICAgIH1cblxuICAgIC8vIEFsd2F5cy1pbmNsdWRlIHBhY2tzIChlc3NlbnRpYWxzKVxuICAgIGlmIChwYWNrLm1hdGNoQWx3YXlzKSB7XG4gICAgICBtYXRjaGVkLmFkZChwYWNrKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gWy4uLm1hdGNoZWRdO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSW5zdGFsbGF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEluc3RhbGwgYSBza2lsbCBwYWNrIHZpYSB0aGUgc2tpbGxzLnNoIENMSS5cbiAqIFJ1bnM6IG5weCBza2lsbHMgYWRkIDxyZXBvPiAtLXNraWxsIDxuYW1lPiAuLi4gLXlcbiAqXG4gKiBSZXR1cm5zIHRydWUgaWYgaW5zdGFsbGF0aW9uIHN1Y2NlZWRlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxTa2lsbFBhY2socGFjazogU2tpbGxQYWNrKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgIC8vIC0teWVzID0gbnB4IGF1dG8taW5zdGFsbCwgLXkgPSBza2lsbHMuc2ggbm9uLWludGVyYWN0aXZlXG4gICAgY29uc3QgYXJncyA9IFtcIi0teWVzXCIsIFwic2tpbGxzXCIsIFwiYWRkXCIsIHBhY2sucmVwb107XG5cbiAgICBmb3IgKGNvbnN0IHNraWxsIG9mIHBhY2suc2tpbGxzKSB7XG4gICAgICBhcmdzLnB1c2goXCItLXNraWxsXCIsIHNraWxsKTtcbiAgICB9XG4gICAgYXJncy5wdXNoKFwiLXlcIik7XG5cbiAgICBleGVjRmlsZShcIm5weFwiLCBhcmdzLCB7IHRpbWVvdXQ6IDEyMF8wMDAgfSwgKGVycm9yKSA9PiB7XG4gICAgICByZXNvbHZlKCFlcnJvcik7XG4gICAgfSk7XG4gIH0pO1xufVxuXG4vKipcbiAqIEluc3RhbGwgbXVsdGlwbGUgcGFja3MsIGJhdGNoaW5nIGJ5IHJlcG8gdG8gbWluaW1pemUgbnB4IGludm9jYXRpb25zLlxuICogUmV0dXJucyB0aGUgbGFiZWxzIG9mIHN1Y2Nlc3NmdWxseSBpbnN0YWxsZWQgcGFja3MuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbnN0YWxsUGFja3NCYXRjaGVkKFxuICBwYWNrczogU2tpbGxQYWNrW10sXG4gIG9uUHJvZ3Jlc3M/OiAobGFiZWw6IHN0cmluZykgPT4gdm9pZCxcbik6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgLy8gR3JvdXAgcGFja3MgYnkgcmVwb1xuICBjb25zdCBieVJlcG8gPSBuZXcgTWFwPHN0cmluZywgeyBza2lsbHM6IHN0cmluZ1tdOyBsYWJlbHM6IHN0cmluZ1tdIH0+KCk7XG4gIGZvciAoY29uc3QgcGFjayBvZiBwYWNrcykge1xuICAgIGNvbnN0IGVudHJ5ID0gYnlSZXBvLmdldChwYWNrLnJlcG8pID8/IHsgc2tpbGxzOiBbXSwgbGFiZWxzOiBbXSB9O1xuICAgIGVudHJ5LnNraWxscy5wdXNoKC4uLnBhY2suc2tpbGxzKTtcbiAgICBlbnRyeS5sYWJlbHMucHVzaChwYWNrLmxhYmVsKTtcbiAgICBieVJlcG8uc2V0KHBhY2sucmVwbywgZW50cnkpO1xuICB9XG5cbiAgY29uc3QgaW5zdGFsbGVkOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IFtyZXBvLCB7IHNraWxscywgbGFiZWxzIH1dIG9mIGJ5UmVwbykge1xuICAgIG9uUHJvZ3Jlc3M/LihsYWJlbHMuam9pbihcIiwgXCIpKTtcbiAgICBjb25zdCBvayA9IGF3YWl0IG5ldyBQcm9taXNlPGJvb2xlYW4+KChyZXNvbHZlKSA9PiB7XG4gICAgICAvLyAtLXllcyA9IG5weCBhdXRvLWluc3RhbGwsIC15ID0gc2tpbGxzLnNoIG5vbi1pbnRlcmFjdGl2ZVxuICAgICAgY29uc3QgYXJncyA9IFtcIi0teWVzXCIsIFwic2tpbGxzXCIsIFwiYWRkXCIsIHJlcG9dO1xuICAgICAgZm9yIChjb25zdCBza2lsbCBvZiBza2lsbHMpIHtcbiAgICAgICAgYXJncy5wdXNoKFwiLS1za2lsbFwiLCBza2lsbCk7XG4gICAgICB9XG4gICAgICBhcmdzLnB1c2goXCIteVwiKTtcbiAgICAgIGV4ZWNGaWxlKFwibnB4XCIsIGFyZ3MsIHsgdGltZW91dDogMTIwXzAwMCB9LCAoZXJyb3IpID0+IHtcbiAgICAgICAgcmVzb2x2ZSghZXJyb3IpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gICAgaWYgKG9rKSBpbnN0YWxsZWQucHVzaCguLi5sYWJlbHMpO1xuICB9XG4gIHJldHVybiBpbnN0YWxsZWQ7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYW55IHNraWxscyBmcm9tIGEgcGFjayBhcmUgYWxyZWFkeSBpbnN0YWxsZWQuXG4gKiBTZWFyY2hlcyBib3RoIHRoZSBza2lsbHMuc2ggZWNvc3lzdGVtIGRpcmVjdG9yeSBhbmQgQ2xhdWRlIENvZGUncyBvZmZpY2lhbCBkaXJlY3RvcnkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1BhY2tJbnN0YWxsZWQocGFjazogU2tpbGxQYWNrKTogYm9vbGVhbiB7XG4gIGNvbnN0IHNraWxsc0RpcnMgPSBbXG4gICAgam9pbihob21lZGlyKCksIFwiLmFnZW50c1wiLCBcInNraWxsc1wiKSxcbiAgICBqb2luKGhvbWVkaXIoKSwgXCIuY2xhdWRlXCIsIFwic2tpbGxzXCIpLFxuICBdO1xuXG4gIHJldHVybiBwYWNrLnNraWxscy5ldmVyeSgobmFtZSkgPT5cbiAgICBza2lsbHNEaXJzLnNvbWUoKGRpcikgPT4gZXhpc3RzU3luYyhqb2luKGRpciwgbmFtZSwgXCJTS0lMTC5tZFwiKSkpLFxuICApO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSW5pdCBXaXphcmQgSW50ZWdyYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUnVuIHNraWxsIGluc3RhbGxhdGlvbiBzdGVwIGR1cmluZyBwcm9qZWN0IGluaXQuXG4gKlxuICogQnJvd25maWVsZCAoc2lnbmFscy5kZXRlY3RlZEZpbGVzLmxlbmd0aCA+IDApOlxuICogICBBdXRvLWRldGVjdHMgdGVjaCBzdGFjayBcdTIxOTIgc2hvd3MgbWF0Y2hlZCBwYWNrcyBcdTIxOTIgaW5zdGFsbHMgYWNjZXB0ZWQgb25lcy5cbiAqXG4gKiBHcmVlbmZpZWxkIChubyBmaWxlcyBkZXRlY3RlZCk6XG4gKiAgIEluc3RhbGxzIGVzc2VudGlhbCBwYWNrcyBvbmx5IChmaW5kLXNraWxscywgc2tpbGwtY3JlYXRvciwgZXRjLikuXG4gKiAgIFN0YWNrLXNwZWNpZmljIHNraWxscyBhcmUgZGVmZXJyZWQgXHUyMDE0IG9uY2UgdGhlIExMTSBlc3RhYmxpc2hlcyBhIGRlc2lnblxuICogICBhbmQgY3JlYXRlcyBwcm9qZWN0IGZpbGVzIChwYWNrYWdlLmpzb24sIGZpcmViYXNlLmpzb24sIGV0Yy4pLCBicm93bmZpZWxkXG4gKiAgIGRldGVjdGlvbiB3aWxsIHBpY2sgdGhlbSB1cCBvbiB0aGUgbmV4dCBgZ3NkIGluaXRgIG9yIHZpYSBhdXRvLW1vZGVcbiAqICAgc2tpbGwgZGlzY292ZXJ5LlxuICpcbiAqIFJldHVybnMgdGhlIGxpc3Qgb2YgaW5zdGFsbGVkIHBhY2sgbGFiZWxzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuU2tpbGxJbnN0YWxsU3RlcChcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgc2lnbmFsczogUHJvamVjdFNpZ25hbHMsXG4pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGNvbnN0IGluc3RhbGxlZDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgaXNCcm93bmZpZWxkID0gc2lnbmFscy5kZXRlY3RlZEZpbGVzLmxlbmd0aCA+IDA7XG5cbiAgaWYgKGlzQnJvd25maWVsZCkge1xuICAgIC8vIFx1MjUwMFx1MjUwMCBCcm93bmZpZWxkOiBhdXRvLWRldGVjdCBhbmQgY29uZmlybSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICBjb25zdCBtYXRjaGVkID0gbWF0Y2hQYWNrc0ZvclByb2plY3Qoc2lnbmFscyk7XG4gICAgaWYgKG1hdGNoZWQubGVuZ3RoID09PSAwKSByZXR1cm4gaW5zdGFsbGVkO1xuXG4gICAgLy8gRmlsdGVyIG91dCBhbHJlYWR5LWluc3RhbGxlZCBwYWNrc1xuICAgIGNvbnN0IHRvSW5zdGFsbCA9IG1hdGNoZWQuZmlsdGVyKChwKSA9PiAhaXNQYWNrSW5zdGFsbGVkKHApKTtcbiAgICBpZiAodG9JbnN0YWxsLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGluc3RhbGxlZDtcblxuICAgIC8vIEdyb3VwIGZvciBkaXNwbGF5OiBTd2lmdCBwYWNrcyB2cyBpT1MgcGFja3MgdnMgb3RoZXJcbiAgICBjb25zdCBzd2lmdFBhY2tzID0gdG9JbnN0YWxsLmZpbHRlcigocCkgPT4gcC5tYXRjaExhbmd1YWdlcz8uaW5jbHVkZXMoXCJzd2lmdFwiKSk7XG4gICAgY29uc3QgaW9zUGFja3MgPSB0b0luc3RhbGwuZmlsdGVyKChwKSA9PiBwLm1hdGNoWGNvZGVQbGF0Zm9ybXM/LmluY2x1ZGVzKFwiaXBob25lb3NcIikpO1xuICAgIGNvbnN0IG90aGVyUGFja3MgPSB0b0luc3RhbGwuZmlsdGVyKChwKSA9PiAhc3dpZnRQYWNrcy5pbmNsdWRlcyhwKSAmJiAhaW9zUGFja3MuaW5jbHVkZXMocCkpO1xuXG4gICAgY29uc3Qgc3VtbWFyeUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IGhhc0lPUyA9IHNpZ25hbHMueGNvZGVQbGF0Zm9ybXMuaW5jbHVkZXMoXCJpcGhvbmVvc1wiKTtcbiAgICBpZiAoaGFzSU9TKSB7XG4gICAgICBzdW1tYXJ5TGluZXMucHVzaChgRGV0ZWN0ZWQ6IGlPUyBwcm9qZWN0ICgke3NpZ25hbHMucHJpbWFyeUxhbmd1YWdlID8/IFwic3dpZnRcIn0pYCk7XG4gICAgfSBlbHNlIGlmIChzaWduYWxzLnhjb2RlUGxhdGZvcm1zLmxlbmd0aCA+IDApIHtcbiAgICAgIHN1bW1hcnlMaW5lcy5wdXNoKGBEZXRlY3RlZDogJHtzaWduYWxzLnhjb2RlUGxhdGZvcm1zLmpvaW4oXCIsIFwiKX0gWGNvZGUgcHJvamVjdCAoJHtzaWduYWxzLnByaW1hcnlMYW5ndWFnZSA/PyBcInN3aWZ0XCJ9KWApO1xuICAgIH0gZWxzZSB7XG4gICAgICBzdW1tYXJ5TGluZXMucHVzaChgRGV0ZWN0ZWQ6ICR7c2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UgPz8gXCJ1bmtub3duXCJ9IHByb2plY3RgKTtcbiAgICB9XG4gICAgc3VtbWFyeUxpbmVzLnB1c2goXCJcIik7XG4gICAgc3VtbWFyeUxpbmVzLnB1c2goXCJSZWNvbW1lbmRlZCBza2lsbCBwYWNrczpcIik7XG4gICAgaWYgKHN3aWZ0UGFja3MubGVuZ3RoID4gMCkge1xuICAgICAgc3VtbWFyeUxpbmVzLnB1c2goYCAgU3dpZnQ6ICR7c3dpZnRQYWNrcy5tYXAoKHApID0+IHAubGFiZWwpLmpvaW4oXCIsIFwiKX1gKTtcbiAgICB9XG4gICAgaWYgKGlvc1BhY2tzLmxlbmd0aCA+IDApIHtcbiAgICAgIHN1bW1hcnlMaW5lcy5wdXNoKGAgIGlPUzogJHtpb3NQYWNrcy5tYXAoKHApID0+IHAubGFiZWwpLmpvaW4oXCIsIFwiKX1gKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBwIG9mIG90aGVyUGFja3MpIHtcbiAgICAgIHN1bW1hcnlMaW5lcy5wdXNoKGAgIFx1MjAyMiAke3AubGFiZWx9OiAke3AuZGVzY3JpcHRpb259YCk7XG4gICAgfVxuXG4gICAgY29uc3QgdG90YWxTa2lsbHMgPSB0b0luc3RhbGwucmVkdWNlKChuLCBwKSA9PiBuICsgcC5za2lsbHMubGVuZ3RoLCAwKTtcbiAgICBjb25zdCBjaG9pY2UgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHgsIHtcbiAgICAgIHRpdGxlOiBcIkdTRCBcdTIwMTQgSW5zdGFsbCBTa2lsbHNcIixcbiAgICAgIHN1bW1hcnk6IHN1bW1hcnlMaW5lcyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcImluc3RhbGxcIixcbiAgICAgICAgICBsYWJlbDogXCJJbnN0YWxsIHJlY29tbWVuZGVkIHNraWxsc1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBgSW5zdGFsbCAke3RvdGFsU2tpbGxzfSBza2lsbHMgZnJvbSAke3RvSW5zdGFsbC5sZW5ndGh9IHBhY2ske3RvSW5zdGFsbC5sZW5ndGggPiAxID8gXCJzXCIgOiBcIlwifSB2aWEgc2tpbGxzLnNoYCxcbiAgICAgICAgICByZWNvbW1lbmRlZDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcInNraXBcIixcbiAgICAgICAgICBsYWJlbDogXCJTa2lwXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiSW5zdGFsbCBza2lsbHMgbGF0ZXIgd2l0aCBucHggc2tpbGxzIGFkZFwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2QgaW5pdCB3aGVuIHJlYWR5LlwiLFxuICAgIH0pO1xuXG4gICAgaWYgKGNob2ljZSA9PT0gXCJpbnN0YWxsXCIpIHtcbiAgICAgIGNvbnN0IGxhYmVscyA9IGF3YWl0IGluc3RhbGxQYWNrc0JhdGNoZWQodG9JbnN0YWxsLCAobGFiZWwpID0+IHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShgSW5zdGFsbGluZyAke2xhYmVsfSBza2lsbHMuLi5gLCBcImluZm9cIik7XG4gICAgICB9KTtcbiAgICAgIGluc3RhbGxlZC5wdXNoKC4uLmxhYmVscyk7XG4gICAgICBjb25zdCBmYWlsZWQgPSB0b0luc3RhbGwuZmlsdGVyKChwKSA9PiAhaW5zdGFsbGVkLmluY2x1ZGVzKHAubGFiZWwpKTtcbiAgICAgIGZvciAoY29uc3QgcGFjayBvZiBmYWlsZWQpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShgRmFpbGVkIHRvIGluc3RhbGwgJHtwYWNrLmxhYmVsfSBcdTIwMTQgdHJ5IG1hbnVhbGx5OiBucHggc2tpbGxzIGFkZCAke3BhY2sucmVwb31gLCBcImluZm9cIik7XG4gICAgICB9XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIC8vIFx1MjUwMFx1MjUwMCBHcmVlbmZpZWxkOiBpbnN0YWxsIGVzc2VudGlhbHMgb25seSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAvLyBEb24ndCBhc2sgdGhlIHVzZXIgd2hhdCB0ZWNoIHN0YWNrIHRoZXkncmUgYnVpbGRpbmcgXHUyMDE0IHRoZXkgbWF5IG5vdCBrbm93XG4gICAgLy8geWV0LCBlc3BlY2lhbGx5IG5vbi10ZWNobmljYWwgdXNlcnMuIEluc3RhbGwgZXNzZW50aWFsIHBhY2tzIChkaXNjb3ZlcnksXG4gICAgLy8gYXV0aG9yaW5nLCBicm93c2VyLCBkb2NzKSBhbmQgbGV0IHN0YWNrLXNwZWNpZmljIHNraWxscyBhdXRvLWRldGVjdCBsYXRlclxuICAgIC8vIG9uY2UgdGhlIExMTSBlc3RhYmxpc2hlcyB0aGUgZGVzaWduIGFuZCBjcmVhdGVzIHByb2plY3QgZmlsZXMuXG4gICAgY29uc3QgZXNzZW50aWFscyA9IFNLSUxMX0NBVEFMT0cuZmlsdGVyKChwKSA9PiBwLm1hdGNoQWx3YXlzICYmICFpc1BhY2tJbnN0YWxsZWQocCkpO1xuICAgIGlmIChlc3NlbnRpYWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGluc3RhbGxlZDtcblxuICAgIGNvbnN0IHRvdGFsU2tpbGxzID0gZXNzZW50aWFscy5yZWR1Y2UoKG4sIHApID0+IG4gKyBwLnNraWxscy5sZW5ndGgsIDApO1xuICAgIGNvbnN0IGNob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgICAgdGl0bGU6IFwiR1NEIFx1MjAxNCBJbnN0YWxsIEVzc2VudGlhbCBTa2lsbHNcIixcbiAgICAgIHN1bW1hcnk6IFtcbiAgICAgICAgXCJHU0Qgd2lsbCBpbnN0YWxsIGVzc2VudGlhbCBhZ2VudCBza2lsbHMgKHNraWxsIGRpc2NvdmVyeSwgYXV0aG9yaW5nLFwiLFxuICAgICAgICBcImJyb3dzZXIgYXV0b21hdGlvbiwgZG9jdW1lbnQgaGFuZGxpbmcpLlwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIlN0YWNrLXNwZWNpZmljIHNraWxscyAoUmVhY3QsIFN3aWZ0LCBQeXRob24sIGV0Yy4pIHdpbGwgYmUgcmVjb21tZW5kZWRcIixcbiAgICAgICAgXCJhdXRvbWF0aWNhbGx5IG9uY2UgeW91ciBwcm9qZWN0IGZpbGVzIGFyZSBpbiBwbGFjZS5cIixcbiAgICAgIF0sXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJpbnN0YWxsXCIsXG4gICAgICAgICAgbGFiZWw6IFwiSW5zdGFsbCBlc3NlbnRpYWxzXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IGBJbnN0YWxsICR7dG90YWxTa2lsbHN9IGVzc2VudGlhbCBza2lsbHMgdmlhIHNraWxscy5zaGAsXG4gICAgICAgICAgcmVjb21tZW5kZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJza2lwXCIsXG4gICAgICAgICAgbGFiZWw6IFwiU2tpcFwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIkluc3RhbGwgc2tpbGxzIGxhdGVyIHdpdGggbnB4IHNraWxscyBhZGRcIixcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICBub3RZZXRNZXNzYWdlOiBcIlJ1biAvZ3NkIGluaXQgd2hlbiByZWFkeS5cIixcbiAgICB9KTtcblxuICAgIGlmIChjaG9pY2UgPT09IFwiaW5zdGFsbFwiKSB7XG4gICAgICBjb25zdCBsYWJlbHMgPSBhd2FpdCBpbnN0YWxsUGFja3NCYXRjaGVkKGVzc2VudGlhbHMsIChsYWJlbCkgPT4ge1xuICAgICAgICBjdHgudWkubm90aWZ5KGBJbnN0YWxsaW5nICR7bGFiZWx9IHNraWxscy4uLmAsIFwiaW5mb1wiKTtcbiAgICAgIH0pO1xuICAgICAgaW5zdGFsbGVkLnB1c2goLi4ubGFiZWxzKTtcbiAgICB9XG4gIH1cblxuICBpZiAoaW5zdGFsbGVkLmxlbmd0aCA+IDApIHtcbiAgICBjdHgudWkubm90aWZ5KGBJbnN0YWxsZWQ6ICR7aW5zdGFsbGVkLmpvaW4oXCIsIFwiKX1gLCBcImluZm9cIik7XG4gIH1cblxuICByZXR1cm4gaW5zdGFsbGVkO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBY0EsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsZUFBZTtBQUV4QixTQUFTLHNCQUFzQjtBQTBCeEIsTUFBTSxnQkFBNkI7QUFBQTtBQUFBLEVBRXhDO0FBQUEsSUFD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
