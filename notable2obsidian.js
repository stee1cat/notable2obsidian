#!/usr/bin/env node

const path = require('path');  
const fs = require('fs').promises;

const newLine = '\n';
const attachmentsDir = 'attachments';
const notebookRe = /^Notebooks\//;
const propertiesSectionRe = /^---((?:.|[\r\n])*?)---/g;

function extractProperties(data) {
    const result = {
        title: '',
        deleted: false,
        tags: [],
        attachments: [],
    };

    let match = data.match(propertiesSectionRe);

    if (match) {
        const metadata = match[0];

        // string
        const stringsProperties = /(title|created|modified): ([^\n]+)/gi;
        match = metadata.matchAll(stringsProperties);
        if (match) {
            const properties = Array.from(match)

            for (let i = 0; i < properties.length; i++) {
                const [, key, value] = properties[i];

                result[key] = value;
            }
        }

        // boolean
        const booleanProperties = /(deleted|favorited): ([^\n]+)/gi;
        match = metadata.matchAll(booleanProperties);
        if (match) {
            const properties = Array.from(match)

            for (let i = 0; i < properties.length; i++) {
                const [, key, value] = properties[i];

                result[key] = value === 'true';
            }
        }

        // array of strings
        const arrayProperties = /(tags|attachments): \[([^\]]+)\]/gi;
        match = metadata.matchAll(arrayProperties);
        if (match) {
            const properties = Array.from(match)

            for (let i = 0; i < properties.length; i++) {
                const [, key, value] = properties[i];

                result[key] = value.split(',').map(s => s.trim());
            }
        }
    }

    return result;
}

function generatePropertiesSection(properties) {
    let result = Object.keys(properties)
        .filter((property) => ['favorited', 'created', 'modified'].includes(property))
        .map((property) => `${property}: ${properties[property]}`)
        .join(newLine);

    if (result.length) {
        result += newLine;
    }

    if (properties.tags?.length) {
        result += `tags: [${properties.tags.join(', ')}]${newLine}`
    }

    if (properties.attachments?.length) {
        const attachments = properties.attachments.map((attachment) => `${attachmentsDir}/${attachment}`)
            .join(', ');

        result += `attachments: [${attachments}]${newLine}`
    }

    return result ? `---${newLine}${result}---${newLine}`  : '';
}

function removePropertiesSection(data) {
    return data.trim()
        .replace(propertiesSectionRe, '')
        .trim();
}

async function readNotable(notableDir, results = new Map()) {  
    //
    // Read Notable entries, extract some metadata, and cache
    //
    let files = await fs.readdir(notableDir, { withFileTypes : true } );
    for await (let file of files) {
        let fullPath = path.join(notableDir, file.name);
        if (file.isDirectory()) {
            await readNotable(fullPath, results);
        } else {
            console.info(`* Caching "${fullPath}"...`);

            const data = await fs.readFile(fullPath, 'utf-8' );
            const properties = extractProperties(data);

            if (!properties.deleted) {
                const notebook = properties.tags.find((p) => p.match(notebookRe));
                if (notebook) {
                    const notebookIdx = properties.tags.findIndex((p) => p === notebook);
                    if (notebookIdx > -1) {
                        properties.tags.splice(notebookIdx, 1);
                    }

                    const dirPath = notebook.replace(notebookRe, '');
                    const fileName = path.basename(fullPath);

                    fullPath = path.join(notableDir, dirPath, fileName);
                }

                const entry = {
                    fullPath,
                    data: removePropertiesSection(data),
                    properties,
                };

                results.set(properties.title, entry);
            }
        }
    }
    return results;
}

async function migrateTo(entriesCache, notableDir, obsidianVaultDir) {  
    //
    //  Re-read Notable entries, converting to Obsidian
    //  - Internal links of [Title](@note/foo.md) -> [[Title]]
    //
    for (const [title, entry] of entriesCache) {
        // Example:
        // From: c:\path\to\notable\notes\sub\foo.md
        // To: c:\path\to\obsidian\myVault\sub\foo.md
        const vaultRelPath = entry.fullPath.replace(notableDir, '');
        let vaultFullPath = path.dirname(path.join(obsidianVaultDir, vaultRelPath));
        vaultFullPath = path.join(vaultFullPath, `${path.basename(entry.fullPath)}`);

        console.info(`* Processing "${title}" @ ${entry.fullPath} -> ${vaultFullPath}...`);

        let newData = entry.data;
        let match;

        const noteRe = /\[([\w\s]+)\]\(@note\/([\w\s\/\-_\+\.\:]+)\.md\)/g;
        while ((match = noteRe.exec(entry.data))) {
            const base = path.dirname(vaultRelPath).substr(1);
            let newLink = path.join(base, path.basename(match[2], '.md'));
            const linkTitle = match[1] === newLink ? '' : `\\|${match[1]}`;
            newLink = `[[${newLink}${linkTitle}]]`;
            console.log(`  > Internal link: ${match[0]} -> ${newLink}`);
            newData = newData.replace(match[0], newLink);
        }

        const attachmentRe = /\[\]\(@attachment\/([\w\s\/\-_\+\.\:]+)\)/g;
        while ((match = attachmentRe.exec(entry.data))) {
            let newLink = `[[${attachmentsDir}/${match[1]}]]`;
            console.log(`  > Attachment: ${match[0]} -> ${newLink}`);
            newData = newData.replace(match[0], newLink);
        }

        newData = `${generatePropertiesSection(entry.properties)}${newLine}${newData}`;

        await fs.mkdir(path.dirname(vaultFullPath), { recursive: true } );
        await fs.writeFile(vaultFullPath, newData, { encoding : 'utf-8'} );
    }
}

async function validDirectories(paths) {  
    for (const path of paths) {
        if (!path) {
            return false;
        }

        const stats = await fs.stat(path);
            if (!stats.isDirectory()) {
                return false;
            }
    }

    return true;
}

async function main() {  
    //
    //  This isn't the most optimized approach in the world,
    //  but this should be a one time migrate, so oh well...
    //
    const notableDir = process.argv[2];
    const obsidianVaultDir = process.argv[3];

    const validDirs = await validDirectories([notableDir, obsidianVaultDir]);
    if (!validDirs) {       
        return console.error('Usage: notable2obsidian.js <notableDir> <vaultDir>');
    }

    const entriesCache = await readNotable(process.argv[2])
    await migrateTo(entriesCache, notableDir, obsidianVaultDir);

    return 0;
}

main().then().catch(console.error);  

