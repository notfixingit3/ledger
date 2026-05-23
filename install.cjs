const fs = require('fs');
const path = require('path');
const os = require('os');

const homedir = os.homedir();
const opencodeDir = path.join(homedir, '.config', 'opencode');
const pluginsDir = path.join(opencodeDir, 'plugins');
const destFile = path.join(pluginsDir, 'ledger.ts');

console.log('Installing OpenCode Ledger globally...');

// 1. Ensure plugins directory exists
if (!fs.existsSync(pluginsDir)) {
  fs.mkdirSync(pluginsDir, { recursive: true });
}

// 2. Copy index.ts to the global plugins folder
try {
  fs.copyFileSync(path.join(__dirname, 'index.ts'), destFile);
  console.log(`✅ Copied index.ts to ${destFile}`);
} catch (err) {
  console.error(`❌ Failed to copy index.ts: ${err.message}`);
  process.exit(1);
}

// 3. Update opencode.json and opencode.jsonc configurations if they exist
const configFiles = ['opencode.json', 'opencode.jsonc'];
const newItem = './plugins/ledger.ts';

configFiles.forEach(file => {
  const filePath = path.join(opencodeDir, file);
  if (!fs.existsSync(filePath)) return;

  try {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Match the "plugin" array key and capture elements
    const pluginRegex = /("plugin"\s*:\s*\[)([\s\S]*?)(\])/;
    
    if (pluginRegex.test(content)) {
      content = content.replace(pluginRegex, (match, prefix, list, suffix) => {
        if (list.includes(newItem)) {
          console.log(`ℹ️ Ledger plugin is already enabled in ${file}`);
          return match;
        }
        
        const trimmedList = list.trim();
        const separator = trimmedList.length > 0 && !trimmedList.endsWith(',') ? ',\n    ' : '\n    ';
        const formattedNewItem = `"${newItem}"`;
        
        let updatedList = list;
        if (trimmedList.length === 0) {
          updatedList = `\n    ${formattedNewItem}\n  `;
        } else {
          updatedList = list.replace(/(\s*)$/, `${separator}${formattedNewItem}$1`);
        }
        
        console.log(`✅ Enabled ledger plugin in ${file}`);
        return `${prefix}${updatedList}${suffix}`;
      });
    } else {
      // If "plugin" key doesn't exist, insert it at the top of the JSON object
      const braceRegex = /^(\s*\{)/;
      if (braceRegex.test(content)) {
        content = content.replace(braceRegex, `$1\n  "plugin": [\n    "${newItem}"\n  ],`);
        console.log(`✅ Created "plugin" array and enabled ledger plugin in ${file}`);
      } else {
        console.warn(`⚠️ Could not automatically modify structure of ${file}. Please add "${newItem}" to your plugins array manually.`);
      }
    }
    
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    console.error(`❌ Failed to update ${file}: ${err.message}`);
  }
});

console.log('🎉 Setup complete!');
