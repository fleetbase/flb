#!/usr/bin/env node

const { program } = require('commander');
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const packageJson = require('./package.json');

function publishPackage(packagePath, registry, options = {}) {
    if (typeof options.onBefore === 'function') {
        options.onBefore();
    }

    const publishCommand = `npm publish ${packagePath} --registry ${registry}`;

    exec(publishCommand, async (error, stdout, stderr) => {
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

function unpublishPackage(packageName, registry, options = {}) {
    if (typeof options.onBefore === 'function') {
        options.onBefore();
    }

    const unpublishCommand = `npm unpublish ${packageName} --registry ${registry}`;

    exec(unpublishCommand, (error, stdout, stderr) => {
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

async function getPackageNameFromCurrentDirectory() {
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

async function createComposerJsonFromPackage(packagePath) {
    const composerJson = await fs.readJson(path.join(packagePath, 'composer.json'));
    const packageJson = convertComposerToPackage(composerJson);

    await fs.writeJson(path.join(packagePath, 'package.json'), packageJson, { spaces: 4 });
}

function convertComposerToPackage(composerJson) {
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

async function onBeforePublishComposer(packagePath) {
    console.log('Converting composer.json to package.json...');
    await createComposerJsonFromPackage(packagePath);
}

function onAfterPublishComposer(packagePath) {
    console.log('Cleaning up generated package.json...');
    fs.removeSync(path.join(packagePath, 'package.json'));
}

const defaultRegistry = 'http://localhost:4873';

program.name('flb-cli').description('CLI tool for managing Fleetbase Extensions').version(`${packageJson.name} ${packageJson.version}`, '-v, --version', 'Output the current version');
program.option('-r, --registry [url]', 'Specify a fleetbase extension repository', defaultRegistry);

program
    .command('publish [path]')
    .description('Publish a Fleetbase Extension')
    .action(async (packagePath = '.') => {
        const registry = program.opts().registry;
        console.log(`Using registry: ${registry}`);

        const hasPackageJson = await fs.pathExists(path.join(packagePath, 'package.json'));
        const hasComposerJson = await fs.pathExists(path.join(packagePath, 'composer.json'));

        if (hasPackageJson) {
            console.log('Publishing as an npm package...');
            publishPackage(packagePath, registry);
        } else if (hasComposerJson) {
            console.log('Publishing as a Composer package...');
            await createComposerJsonFromPackage(packagePath);
            publishPackage(packagePath, registry, {
                onBefore: () => onBeforePublishComposer(packagePath),
                onAfter: () => onAfterPublishComposer(packagePath),
            });
        } else {
            console.error('No package.json or composer.json found.');
        }
    });

program
    .command('unpublish [packageName]')
    .description('Unpublish a Fleetbase Extension')
    .action(async (packageName) => {
        const registry = program.opts().registry;
        console.log(`Using registry: ${registry}`);

        if (!packageName) {
            packageName = await getPackageNameFromCurrentDirectory();
            if (!packageName) {
                console.error('Package name could not be determined.');
                return;
            }
        }

        console.log(`Unpublishing package ${packageName}`);
        unpublishPackage(packageName, registry);
    });

program
    .command('version')
    .description('Output the version number')
    .action(() => {
        console.log(`${packageJson.name} ${packageJson.version}`);
    });

program.parse(process.argv);
