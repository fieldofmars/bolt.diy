import { json } from '@remix-run/cloudflare';
import JSZip from 'jszip';

// Function to detect if we're running in Cloudflare
function isCloudflareEnvironment(context: any): boolean {
  // Check if we're in production AND have Cloudflare Pages specific env vars
  const isProduction = process.env.NODE_ENV === 'production';
  const hasCfPagesVars = !!(
    context?.cloudflare?.env?.CF_PAGES ||
    context?.cloudflare?.env?.CF_PAGES_URL ||
    context?.cloudflare?.env?.CF_PAGES_COMMIT_SHA
  );

  return isProduction && hasCfPagesVars;
}

// Cloudflare-compatible method using GitHub Contents API
async function fetchRepoContentsCloudflare(repo: string, githubToken?: string) {
  const baseUrl = 'https://api.github.com';

  // Get repository info to find default branch
  const repoResponse = await fetch(`${baseUrl}/repos/${repo}`, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'bolt.diy-app',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });

  if (!repoResponse.ok) {
    throw new Error(`Repository not found: ${repo}`);
  }

  const repoData = (await repoResponse.json()) as any;
  const defaultBranch = repoData.default_branch;

  // Get the tree recursively
  const treeResponse = await fetch(`${baseUrl}/repos/${repo}/git/trees/${defaultBranch}?recursive=1`, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'bolt.diy-app',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });

  if (!treeResponse.ok) {
    throw new Error(`Failed to fetch repository tree: ${treeResponse.status}`);
  }

  const treeData = (await treeResponse.json()) as any;

  // Filter for files only (not directories) and limit size
  const files = treeData.tree.filter((item: any) => {
    if (item.type !== 'blob') {
      return false;
    }

    if (item.path.startsWith('.git/')) {
      return false;
    }

    // Allow lock files even if they're large
    const isLockFile =
      item.path.endsWith('package-lock.json') ||
      item.path.endsWith('yarn.lock') ||
      item.path.endsWith('pnpm-lock.yaml');

    // For non-lock files, limit size to 100KB
    if (!isLockFile && item.size >= 100000) {
      return false;
    }

    return true;
  });

  // Fetch file contents in batches to avoid overwhelming the API
  const batchSize = 10;
  const fileContents = [];

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchPromises = batch.map(async (file: any) => {
      try {
        const contentResponse = await fetch(`${baseUrl}/repos/${repo}/contents/${file.path}`, {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'bolt.diy-app',
            ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
          },
        });

        if (!contentResponse.ok) {
          console.warn(`Failed to fetch ${file.path}: ${contentResponse.status}`);
          return null;
        }

        const contentData = (await contentResponse.json()) as any;
        const content = atob(contentData.content.replace(/\s/g, ''));

        return {
          name: file.path.split('/').pop() || '',
          path: file.path,
          content,
        };
      } catch (error) {
        console.warn(`Error fetching ${file.path}:`, error);
        return null;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    fileContents.push(...batchResults.filter(Boolean));

    // Add a small delay between batches to be respectful to the API
    if (i + batchSize < files.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return fileContents;
}

// Your existing method for non-Cloudflare environments
async function fetchRepoContentsZip(repo: string, githubToken?: string) {
  const baseUrl = 'https://api.github.com';

  // Get the latest release
  const releaseResponse = await fetch(`${baseUrl}/repos/${repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'bolt.diy-app',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });

  if (!releaseResponse.ok) {
    throw new Error(`GitHub API error: ${releaseResponse.status} - ${releaseResponse.statusText}`);
  }

  const releaseData = (await releaseResponse.json()) as any;
  const zipballUrl = releaseData.zipball_url;

  // Fetch the zipball
  const zipResponse = await fetch(zipballUrl, {
    headers: {
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });

  if (!zipResponse.ok) {
    throw new Error(`Failed to fetch release zipball: ${zipResponse.status}`);
  }

  // Get the zip content as ArrayBuffer
  const zipArrayBuffer = await zipResponse.arrayBuffer();

  // Use JSZip to extract the contents
  const zip = await JSZip.loadAsync(zipArrayBuffer);

  // Find the root folder name
  let rootFolderName = '';
  zip.forEach((relativePath) => {
    if (!rootFolderName && relativePath.includes('/')) {
      rootFolderName = relativePath.split('/')[0];
    }
  });

  // Extract all files
  const promises = Object.keys(zip.files).map(async (filename) => {
    const zipEntry = zip.files[filename];

    // Skip directories
    if (zipEntry.dir) {
      return null;
    }

    // Skip the root folder itself
    if (filename === rootFolderName) {
      return null;
    }

    // Remove the root folder from the path
    let normalizedPath = filename;

    if (rootFolderName && filename.startsWith(rootFolderName + '/')) {
      normalizedPath = filename.substring(rootFolderName.length + 1);
    }

    // Get the file content
    const content = await zipEntry.async('string');

    return {
      name: normalizedPath.split('/').pop() || '',
      path: normalizedPath,
      content,
    };
  });

  const results = await Promise.all(promises);

  return results.filter(Boolean);
}

export async function loader({ request, context }: { request: Request; context: any }) {
  const url = new URL(request.url);
  const repo = url.searchParams.get('repo');

  if (!repo) {
    return json({ error: 'Repository name is required' }, { status: 400 });
  }

  if (repo === 'bolt-shinylive-template') {
    return json([
      {
        name: 'package.json',
        path: 'package.json',
        content: `{
  "name": "bolt-shinylive-template",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "node server.js",
    "start": "node server.js"
  },
  "dependencies": {
    "lz-string": "^1.5.0"
  }
}`
      },
      {
        name: 'server.js',
        path: 'server.js',
        content: `import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import LZString from 'lz-string';

const PORT = 5173;

async function getFiles(dir, baseDir = '') {
  let results = [];
  try {
    const list = await fs.readdir(dir, { withFileTypes: true });
    for (const file of list) {
      if (['node_modules', '.git', 'server.js', 'package.json', 'package-lock.json', '.bolt'].includes(file.name)) continue;
      const fullPath = path.join(dir, file.name);
      const relPath = path.join(baseDir, file.name).replace(/\\\\/g, '/');
      if (file.isDirectory()) {
        results = results.concat(await getFiles(fullPath, relPath));
      } else {
        const content = await fs.readFile(fullPath, 'utf8');
        results.push({ name: relPath, content });
      }
    }
  } catch(e) {
    console.error('Error reading directory:', e);
  }
  return results;
}

http.createServer(async (req, res) => {
  if (req.url === '/') {
    try {
      const files = await getFiles(process.cwd());
      
      // Compress files into a shinylive URL payload
      const payload = JSON.stringify(files);
      const compressed = LZString.compressToEncodedURIComponent(payload);
      const iframeUrl = \`https://shinylive.io/r/app/#code=\${compressed}\`;

      const html = \`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Shiny WebR App</title>
    <style>
        body, html { margin: 0; padding: 0; height: 100vh; overflow: hidden; font-family: sans-serif; background-color: #f8f9fa; }
        iframe { width: 100%; height: 100%; border: none; display: block; }
        .fallback { position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.7); color: white; padding: 8px 12px; border-radius: 4px; text-decoration: none; font-size: 14px; z-index: 1000; }
        .fallback:hover { background: rgba(0,0,0,0.9); }
    </style>
</head>
<body>
    <a href="\${iframeUrl}" target="_blank" class="fallback">Open in New Tab (If preview is blank)</a>
    <iframe src="\${iframeUrl}" allow="fullscreen"></iframe>
    <script>
        console.log("Shiny App Initialized!");
        console.log("Total files bundled: \${files.length}");
        console.log("If the screen is white, click the 'Open in New Tab' button in the top right.");
    </script>
</body>
</html>\`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(PORT, () => {
  console.log('Server running at http://localhost:' + PORT);
});`
      },
      {
        name: 'global.R',
        path: 'global.R',
        content: `library(shiny)

# Source functions
source("R/functions.R")

# Load data if needed
# my_data <- read.csv("data/dataset.csv")

# Global variables
app_title <- "Shiny WebR App (Multi-file)"
`
      },
      {
        name: 'ui.R',
        path: 'ui.R',
        content: `fluidPage(
  titlePanel(app_title),
  sidebarLayout(
    sidebarPanel(
      sliderInput("bins", "Number of bins:", min = 1, max = 50, value = 30)
    ),
    mainPanel(
      plotOutput("distPlot")
    )
  )
)
`
      },
      {
        name: 'server.R',
        path: 'server.R',
        content: `function(input, output, session) {
  output$distPlot <- renderPlot({
    x <- faithful[, 2]
    bins <- seq(min(x), max(x), length.out = input$bins + 1)
    
    # Use function from R/functions.R
    custom_hist(x, bins, "Waiting time to next eruption (in mins)")
  })
}
`
      },
      {
        name: 'functions.R',
        path: 'R/functions.R',
        content: `# Helper functions for the Shiny app
custom_hist <- function(x, bins, xlab) {
  hist(x, breaks = bins, col = 'steelblue', border = 'white',
       xlab = xlab,
       main = 'Histogram')
}
`
      },
      {
        name: 'dataset.csv',
        path: 'data/dataset.csv',
        content: `id,value
1,10
2,20
3,30`
      },
      {
        name: 'test_basic.R',
        path: 'tests/test_basic.R',
        content: `library(testthat)

test_that("dummy test", {
  expect_equal(1 + 1, 2)
})`
      },
      {
        name: 'prompt',
        path: '.bolt/prompt',
        content: `You are an expert R developer building a Shiny application.
This project uses Posit's webR and Shinylive to run natively in the browser.

IMPORTANT RULES:
1. ONLY write R code for the application logic. DO NOT write React, Vue, or Javascript components for the UI.
2. Follow the multi-file Shiny paradigm: \`ui.R\`, \`server.R\`, and \`global.R\`.
3. Place helper functions in the \`R/\` directory.
4. Place data files in the \`data/\` directory.
5. Place tests in the \`tests/\` directory.
6. DO NOT modify \`server.js\` or \`package.json\`. These are required to serve the app to the browser natively via webR.
7. NEVER execute \`R\`, \`Rscript\`, or \`R -e\` commands in the terminal (like \`shiny::runApp('.')\`). WebContainers run Node.js, not native R. The app starts automatically via \`npm run dev\` (\`node server.js\`).`
      }
    ]);
  }

  try {
    // Access environment variables from Cloudflare context or process.env
    const githubToken =
      context?.cloudflare?.env?.GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.VITE_GITHUB_ACCESS_TOKEN;

    let fileList;

    if (isCloudflareEnvironment(context)) {
      fileList = await fetchRepoContentsCloudflare(repo, githubToken);
    } else {
      fileList = await fetchRepoContentsZip(repo, githubToken);
    }

    // Filter out .git files for both methods
    const filteredFiles = fileList.filter((file: any) => !file.path.startsWith('.git'));

    return json(filteredFiles);
  } catch (error) {
    console.error('Error processing GitHub template:', error);
    console.error('Repository:', repo);
    console.error('Error details:', error instanceof Error ? error.message : String(error));

    return json(
      {
        error: 'Failed to fetch template files',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
