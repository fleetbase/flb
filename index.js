#!/usr/bin/env node

const { program } = require('commander');
const { exec } = require('child_process');
const { prompt } = require('enquirer');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const _ = require('lodash');
const packageJson = require('./package.json');
const maxBuffer = 1024 * 1024 * 50; // 50MB
const defaultRegistry = 'https://registry.fleetbase.io';
const packageLookupApi = 'https://api.fleetbase.io/~registry/v1/lookup';
const starterExtensionRepo = 'https://github.com/fleetbase/starter-extension.git';

function publishPackage (packagePath, registry, options = {}) {
    if (typeof options.onBefore === 'function') {
        options.onBefore();
    }

    const publishCommand = `npm publish ${packagePath} --registry ${registry}`;

    // Check if logged in
    exec(`npm whoami --registry ${registry}`, (error, stdout, stderr) => {
        if (error) {
            console.error('You must be logged in to publish. Run `npm adduser`.');
            return;
        }

        // Publish the package
        exec(publishCommand, { maxBuffer: maxBuffer }, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                process.exit(1);
                return;
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
                return;
            }
            console.log(`stdout: ${stdout}`);

            if (typeof options.onAfter === 'function') {
                options.onAfter();
            }
        });
    });
}

function unpublishPackage (packageName, registry, options = {}) {
    if (typeof options.onBefore === 'function') {
        options.onBefore();
    }

    const unpublishCommand = `npm unpublish ${packageName} --force --registry=${registry}`;

    exec(unpublishCommand, { maxBuffer: maxBuffer }, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`stderr: ${stderr}`);
            return;
        }
        console.log(`stdout: ${stdout}`);

        if (typeof options.onAfter === 'function') {
            options.onAfter();
        }
    });
}

async function getPackageNameFromCurrentDirectory () {
    const hasPackageJson = await fs.pathExists('package.json');
    const hasComposerJson = await fs.pathExists('composer.json');

    if (hasPackageJson) {
        const packageJson = await fs.readJson('package.json');
        return packageJson.name;
    } else if (hasComposerJson) {
        const composerJson = await fs.readJson('composer.json');
        return composerJson.name;
    }

    return null;
}

async function createComposerJsonFromPackage (packagePath) {
    const composerJson = await fs.readJson(path.join(packagePath, 'composer.json'));
    const packageJson = convertComposerToPackage(composerJson);

    await fs.writeJson(path.join(packagePath, 'package.json'), packageJson, { spaces: 4 });
}

function convertComposerToPackage (composerJson) {
    let packageName = composerJson.name;

    // Convert to scoped package name if it contains a slash
    if (packageName.includes('/')) {
        const parts = packageName.split('/');
        packageName = `@${parts[0]}/${parts[1]}`;
    }

    const packageJson = {
        name: packageName,
        version: composerJson.version,
        description: composerJson.description,
        fleetbase: {
            'from-composer': true,
        },
    };

    return packageJson;
}

async function onBeforePublishComposer (packagePath) {
    console.log('Converting composer.json to package.json...');
    await createComposerJsonFromPackage(packagePath);
}

function onAfterPublishComposer (packagePath) {
    console.log('Cleaning up generated package.json...');
    fs.removeSync(path.join(packagePath, 'package.json'));
}

async function setAuth (token, fleetbasePath = '.', fleetbaseRegistry = defaultRegistry) {
    try {
        if (!token) {
            console.error('Auth token is required.');
            process.exit(1);
        }

        // Expand ~ to the home directory if present
        if (fleetbasePath.startsWith('~')) {
            fleetbasePath = path.join(require('os').homedir(), fleetbasePath.slice(1));
        }

        // Determine Fleetbase path
        const defaultFleetbasePath = '/fleetbase';
        let currentPath = path.resolve(fleetbasePath || '.');

        const consolePath = path.join(currentPath, 'console');
        const apiPath = path.join(currentPath, 'api');

        // Check if console and api directories exist in the current path
        const consoleExists = await fs.pathExists(consolePath);
        const apiExists = await fs.pathExists(apiPath);

        // If not found, fallback to default path
        if (!consoleExists || !apiExists) {
            currentPath = defaultFleetbasePath;
        }

        const npmrcPath = path.join(currentPath, 'console', '.npmrc');
        const composerAuthPath = path.join(currentPath, 'api', 'auth.json');

        // Set the npmrc token
        const authString = `//${new URL(fleetbaseRegistry).host}/:_authToken="${token}"\n`;

        // Append to .npmrc if it exists, otherwise create and write
        if (await fs.pathExists(npmrcPath)) {
            await fs.appendFile(npmrcPath, authString);
            console.log(`NPM auth token set in ${npmrcPath}`);
        } else {
            await fs.writeFile(npmrcPath, authString);
            console.log(`NPM auth token set in ${npmrcPath}`);
        }

        // Set the composer auth token
        const newBearerConfig = {
            bearer: {
                [new URL(fleetbaseRegistry).host]: token,
            },
        };

        let currentComposerAuth = {};
        if (await fs.pathExists(composerAuthPath)) {
            const jsonContent = await fs.readJson(composerAuthPath);
            currentComposerAuth = jsonContent || {};
        }

        const updatedComposerAuth = {
            ...currentComposerAuth,
            bearer: {
                ...currentComposerAuth.bearer,
                ...newBearerConfig.bearer,
            },
        };

        await fs.writeJson(composerAuthPath, updatedComposerAuth, { spaces: 4 });
        console.log(`Composer auth token set in ${composerAuthPath}`);
    } catch (error) {
        console.error(`Error setting auth token: ${error.message}`);
        process.exit(1);
    }
}

async function uninstallPackage (packageName, fleetbasePath = '.') {
    try {
        // Expand ~ to the home directory if present
        if (fleetbasePath.startsWith('~')) {
            fleetbasePath = path.join(require('os').homedir(), fleetbasePath.slice(1));
        }

        // Resolve the Fleetbase instance path
        fleetbasePath = path.resolve(fleetbasePath);

        const consolePath = path.join(fleetbasePath, 'console');
        const apiPath = path.join(fleetbasePath, 'api');

        // Ensure console and api paths exist
        const consoleExists = await fs.pathExists(consolePath);
        const apiExists = await fs.pathExists(apiPath);

        if (!consoleExists || !apiExists) {
            throw new Error(`Invalid Fleetbase instance path: ${fleetbasePath}`);
        }

        // Make the GET request to the lookup API
        const response = await axios.get(packageLookupApi, {
            params: { package: packageName },
        });

        const { npm, composer } = response.data;

        if (!npm || !composer) {
            throw new Error('Invalid package data received from registry');
        }

        console.log(`Uninstalling npm package: ${npm}`);
        await runCommand(`pnpm remove ${npm}`, consolePath);

        console.log(`Uninstalling composer package: ${composer}`);
        await runCommand(`composer remove ${composer}`, apiPath);

        console.log('Package uninstall successful!');
    } catch (error) {
        console.error(`Unnstall failed: ${error.message}`);
    }
}

async function installPackage (packageName, fleetbasePath = '.') {
    try {
        // Expand ~ to the home directory if present
        if (fleetbasePath.startsWith('~')) {
            fleetbasePath = path.join(require('os').homedir(), fleetbasePath.slice(1));
        }

        // Resolve the Fleetbase instance path
        fleetbasePath = path.resolve(fleetbasePath);

        const consolePath = path.join(fleetbasePath, 'console');
        const apiPath = path.join(fleetbasePath, 'api');

        // Ensure console and api paths exist
        const consoleExists = await fs.pathExists(consolePath);
        const apiExists = await fs.pathExists(apiPath);

        if (!consoleExists || !apiExists) {
            throw new Error(`Invalid Fleetbase instance path: ${fleetbasePath}`);
        }

        // Make the GET request to the lookup API
        const response = await axios.get(packageLookupApi, {
            params: { package: packageName },
        });

        const { npm, composer } = response.data;

        if (!npm || !composer) {
            throw new Error('Invalid package data received from registry');
        }

        console.log(`Installing npm package: ${npm}`);
        await runCommand(`pnpm install ${npm}`, consolePath);

        console.log(`Installing composer package: ${composer}`);
        await runCommand(`composer require ${composer}`, apiPath);

        console.log('Package installation successful!');
    } catch (error) {
        console.error(`Installation failed: ${error.message}`);
    }
}

async function scaffoldExtension (options) {
    try {
        // Prompt for extension details
        const answers = await prompt([
            { type: 'input', name: 'name', message: 'Extension Name:', initial: options.name },
            { type: 'input', name: 'description', message: 'Extension Description:', initial: options.description },
            { type: 'input', name: 'author', message: 'Author Name (optional):', initial: options.author },
            { type: 'input', name: 'email', message: 'Author Email (optional):', initial: options.email },
            { type: 'input', name: 'keywords', message: 'Keywords (comma-separated):', initial: options.keywords },
            { type: 'input', name: 'namespace', message: 'PHP Namespace (will be prefixed with "Fleetbase\\", leave blank to use extension name):', initial: options.namespace },
            { type: 'input', name: 'repo', message: 'Repository URL:', initial: options.repo },
        ]);

        const targetDirName = _.kebabCase(answers.name);
        const targetPath = path.resolve(options.path || '.', targetDirName);

        // Check if the target directory exists, and if so, append "-1", "-2", etc. until a unique directory is found
        let counter = 1;
        while (await fs.pathExists(targetPath)) {
            targetDirName = `${_.kebabCase(answers.name)}-${counter}`;
            targetPath = path.resolve(options.path || '.', targetDirName);
            counter++;
        }

        // Clone the repository
        console.log(`Creating new extension in ${targetPath}...`);
        await runCommand(`git clone ${starterExtensionRepo} ${targetPath}`);

        // Process the keywords input
        const keywordsArray = answers.keywords.split(',').map(keyword => keyword.trim());

        // Clean up the author name to remove company entities
        const cleanedAuthorName = answers.author ? answers.author.replace(/\b(llc|pte ltd|inc|corp|gmbh|limited|ltd)\b/gi, '').trim() : 'fleetbase';

        // Determine namespace and package names
        const authorSlug = _.kebabCase(cleanedAuthorName);
        const extensionNameSlug = _.kebabCase(answers.name);
        const extensionClassName = _.startCase(answers.name).replace(/\s+/g, '') + 'Engine';
        const defaultNamespace = `Fleetbase\\${_.startCase(answers.namespace || answers.name).replace(/\s+/g, '')}`;
        const packageJsonName = `@${authorSlug}/${extensionNameSlug}-engine`;
        const composerJsonName = `${authorSlug}/${extensionNameSlug}-api`;

        // Update extension.json, package.json, and composer.json with the prompted details
        const extensionJsonPath = path.join(targetPath, 'extension.json');
        const packageJsonPath = path.join(targetPath, 'package.json');
        const composerJsonPath = path.join(targetPath, 'composer.json');
        const engineJsPath = path.join(targetPath, 'addon/engine.js');
        const controllerPath = path.join(targetPath, 'server/src/Http/Controllers/StarterResourceController.php');
        const serviceProviderPath = path.join(targetPath, 'server/src/Providers/StarterServiceProvider.php');
        const configPath = path.join(targetPath, `server/config/starter.php`);
        const routesPath = path.join(targetPath, `server/src/routes.php`);

        // Load and update files
        await updateJsonFile(extensionJsonPath, {
            name: answers.name,
            description: answers.description,
            repository: answers.repo,
            author: `${answers.author} <${answers.email}>`,
        });

        await updateJsonFile(packageJsonPath, {
            name: packageJsonName,
            description: answers.description,
            repository: answers.repo,
            author: `${answers.author} <${answers.email}>`,
            keywords: keywordsArray,
            fleetbase: {
                route: extensionNameSlug,
            },
        });

        await updateJsonFile(composerJsonPath, {
            name: composerJsonName,
            description: answers.description,
            authors: [
                {
                    name: answers.author,
                    email: answers.email,
                },
            ],
            keywords: keywordsArray,
            autoload: {
                'psr-4': {
                    [`${defaultNamespace}\\`]: 'server/src/',
                    [`${defaultNamespace}\\Seeds\\`]: 'server/seeds/',
                },
            },
            'autoload-dev': {
                'psr-4': {
                    [`${defaultNamespace}\\Tests\\`]: 'server/tests/',
                },
            },
            extra: {
                laravel: {
                    providers: [`${defaultNamespace}\\Providers\\${_.startCase(extensionNameSlug).replace(/\s+/g, '')}ServiceProvider`],
                },
            },
        });

        // Modify files as per the provided extension name
        await modifyEngineJs(engineJsPath, extensionClassName, answers.name);
        await renameAndRefactorFiles(controllerPath, serviceProviderPath, configPath, routesPath, defaultNamespace, extensionNameSlug);

        // Refactor namespaces across all PHP files in the `server/` directory
        await refactorNamespaces(path.join(targetPath, 'server'), defaultNamespace);

        console.log('Extension scaffolded successfully!');
    } catch (error) {
        console.error(`Error scaffolding extension: ${error.message}`);
    }
}

async function updateJsonFile (filePath, updates) {
    if (await fs.pathExists(filePath)) {
        const jsonContent = await fs.readJson(filePath);
        const updatedContent = {
            ...jsonContent,
            ...updates,
            // Append keywords if they exist in the current JSON
            keywords: jsonContent.keywords ? [...jsonContent.keywords, ...(updates.keywords || [])] : updates.keywords,
        };
        await fs.writeJson(filePath, updatedContent, { spaces: 4 });
    }
}

async function modifyEngineJs (filePath, className, displayName) {
    if (await fs.pathExists(filePath)) {
        let content = await fs.readFile(filePath, 'utf-8');
        content = content.replace(/class\s+StarterEngine/, `class ${className}`);
        content = content.replace(/loadInitializers\(StarterEngine, modulePrefix\)/, `loadInitializers(${className}, modulePrefix)`);
        content = content.replace(
            /universe\.registerHeaderMenuItem\('Starter',\s*'console\.starter'/,
            `universe.registerHeaderMenuItem('${displayName}', 'console.${_.kebabCase(className.replace('Engine', ''))}'`
        );
        await fs.writeFile(filePath, content, 'utf-8');
    }
}

async function renameAndRefactorFiles (controllerPath, serviceProviderPath, configPath, routesPath, namespace, extensionSlug) {
    // Renaming and refactoring the controller file
    if (await fs.pathExists(controllerPath)) {
        const newControllerPath = controllerPath.replace('StarterResourceController.php', `${_.upperFirst(_.camelCase(namespace.split('\\').pop()))}ResourceController.php`);
        await fs.rename(controllerPath, newControllerPath);
        await refactorPhpFile(newControllerPath, namespace);
    }

    // Renaming and refactoring the service provider file
    if (await fs.pathExists(serviceProviderPath)) {
        const newServiceProviderPath = serviceProviderPath.replace('StarterServiceProvider.php', `${_.upperFirst(_.camelCase(namespace.split('\\').pop()))}ServiceProvider.php`);
        await fs.rename(serviceProviderPath, newServiceProviderPath);
        await refactorPhpFile(newServiceProviderPath, namespace);
    }

    // Refactoring the config file and removing the old one
    if (await fs.pathExists(configPath)) {
        let content = await fs.readFile(configPath, 'utf-8');
        content = content.replace(/'starter'/g, `'${extensionSlug}'`);
        const newConfigPath = configPath.replace('starter.php', `${extensionSlug}.php`);
        await fs.writeFile(newConfigPath, content, 'utf-8');
        await fs.remove(configPath); // Remove the old config file
    }

    // Refactoring the routes file
    if (await fs.pathExists(routesPath)) {
        let content = await fs.readFile(routesPath, 'utf-8');
        content = content.replace(/config\('starter\./g, `config('${extensionSlug}.`);
        content = content.replace(/'Fleetbase\\Starter\\Http\\Controllers'/g, `'${namespace}\\Http\\Controllers'`);
        content = content.replace(/Starter API Routes/g, `${_.startCase(extensionSlug)} API Routes`);
        await fs.writeFile(routesPath, content, 'utf-8');
    }
}

async function refactorPhpFile (filePath, namespace) {
    if (await fs.pathExists(filePath)) {
        let content = await fs.readFile(filePath, 'utf-8');
        // Replace the namespace declaration
        content = content.replace(/public string \$namespace = '\\\\Fleetbase\\\\Starter';/g, `public string $namespace = '\\${namespace}';`);
        // Replace any other occurrences of the old namespace
        content = content.replace(/Fleetbase\\Starter/g, namespace);
        // Replace class names if necessary
        content = content.replace(/class\s+StarterResourceController/g, `class ${_.upperFirst(_.camelCase(namespace.split('\\').pop()))}ResourceController`);
        content = content.replace(/class\s+StarterServiceProvider/g, `class ${_.upperFirst(_.camelCase(namespace.split('\\').pop()))}ServiceProvider`);
        await fs.writeFile(filePath, content, 'utf-8');
    }
}

async function refactorNamespaces (targetDir, newNamespace) {
    const phpFiles = await findPhpFiles(targetDir);

    for (const file of phpFiles) {
        await refactorPhpFile(file, newNamespace);
    }
}

async function findPhpFiles (dir) {
    const ext = '.php';
    const files = await fs.readdir(dir);
    const phpFiles = [];

    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
            phpFiles.push(...(await findPhpFiles(fullPath)));
        } else if (fullPath.endsWith(ext)) {
            phpFiles.push(fullPath);
        }
    }

    return phpFiles;
}

function runCommand (command, workingDirectory) {
    return new Promise((resolve, reject) => {
        exec(command, { cwd: workingDirectory }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                return reject(error);
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
            }
            console.log(`stdout: ${stdout}`);
            resolve(stdout);
        });
    });
}

program.name('flb').description('CLI tool for managing Fleetbase Extensions').version(`${packageJson.name} ${packageJson.version}`, '-v, --version', 'Output the current version');
program.option('-r, --registry [url]', 'Specify a fleetbase extension repository', defaultRegistry);

program
    .command('set-auth [token]')
    .option('-p, --path <path>', 'Path of the Fleetbase instance to install setup for')
    .option('-r, --registry <url>', 'Registry URL the credentials are for', defaultRegistry)
    .description('Set registry auth token')
    .action(async (token, { path, registry }) => {
        const fleetbasePath = path || '.';
        const fleetbaseRegistry = program.opts().registry ?? registry;
        console.log(`Using registry: ${fleetbaseRegistry}`);
        console.log(`Using path: ${fleetbasePath}`);
        await setAuth(token, fleetbasePath, fleetbaseRegistry);
    });

program
    .command('scaffold')
    .description('Scaffold a new Fleetbase extension')
    .option('-p, --path <path>', 'Path to scaffold the extension into', '.')
    .option('-n, --name <name>', 'Name of the extension to scaffold')
    .option('-d, --description <description>', 'Description of the extension to scaffold')
    .option('-a, --author <author>', 'Name of the extension author')
    .option('-e, --email <email>', 'Email of the extension author')
    .option('-k, --keywords <keywords>', 'Keywords of the extension to scaffold')
    .option('-n, --namespace <namespace>', 'PHP Namespace of the extension to scaffold')
    .option('-r, --repo <repo>', 'Repository URL of the extension to scaffold', starterExtensionRepo.replace('.git', ''))
    .action(scaffoldExtension);

program
    .command('install [packageName]')
    .option('-p, --path <path>', 'Path of the Fleetbase instance to install to')
    .description('Install a Fleetbase Extension')
    .action(async (packageName, { path }) => {
        const fleetbasePath = path || '.';
        console.log(`Installing package: ${packageName}`);
        console.log(`Using path: ${fleetbasePath}`);
        await installPackage(packageName, fleetbasePath);
    });

program
    .command('uninstall [packageName]')
    .option('-p, --path <path>', 'Path of the Fleetbase instance to uninstall for')
    .description('Uninstall a Fleetbase Extension')
    .action(async (packageName, { path }) => {
        const fleetbasePath = path || '.';
        console.log(`Uninstalling package: ${packageName}`);
        console.log(`Using path: ${fleetbasePath}`);
        await uninstallPackage(packageName, fleetbasePath);
    });

program
    .command('publish [packagePath]')
    .option('-r, --registry <url>', 'Registry URL the credentials are for', defaultRegistry)
    .description('Publish a Fleetbase Extension')
    .action(async (packagePath = '.', { registry }) => {
        const fleetbaseRegistry = program.opts().registry ?? registry;
        console.log(`Using registry: ${fleetbaseRegistry}`);

        const hasPackageJson = await fs.pathExists(path.join(packagePath, 'package.json'));
        const hasComposerJson = await fs.pathExists(path.join(packagePath, 'composer.json'));

        console.log('Publishing Fleetbase Extension...');
        if (hasPackageJson) {
            publishPackage(packagePath, fleetbaseRegistry);
        } else if (hasComposerJson) {
            await createComposerJsonFromPackage(packagePath);
            publishPackage(packagePath, fleetbaseRegistry, {
                onBefore: () => onBeforePublishComposer(packagePath),
                onAfter: () => onAfterPublishComposer(packagePath),
            });
        } else {
            console.error('No package.json or composer.json found.');
        }
    });

program
    .command('unpublish [packageName]')
    .option('-r, --registry <url>', 'Registry URL the credentials are for', defaultRegistry)
    .description('Unpublish a Fleetbase Extension')
    .action(async (packageName, { registry }) => {
        const fleetbaseRegistry = program.opts().registry ?? registry;
        console.log(`Using registry: ${fleetbaseRegistry}`);

        if (!packageName) {
            packageName = await getPackageNameFromCurrentDirectory();
            if (!packageName) {
                console.error('Package name could not be determined.');
                return;
            }
        }

        console.log(`Unpublishing Fleetbase Extension ${packageName}`);
        unpublishPackage(packageName, fleetbaseRegistry);
    });

program
    .command('version')
    .description('Output the version number')
    .action(() => {
        console.log(`${packageJson.name} ${packageJson.version}`);
    });

program.parse(process.argv);
