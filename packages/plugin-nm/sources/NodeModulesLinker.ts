import {structUtils, Report, Manifest, miscUtils, formatUtils}              from '@yarnpkg/core';
import {Locator, Package, FinalizeInstallStatus, hashUtils}                 from '@yarnpkg/core';
import {Linker, LinkOptions, MinimalLinkOptions, LinkType, WindowsLinkType} from '@yarnpkg/core';
import {LocatorHash, Descriptor, DependencyMeta, Configuration}             from '@yarnpkg/core';
import {MessageName, Project, FetchResult, Installer}                       from '@yarnpkg/core';
import {PortablePath, npath, ppath, Filename}                               from '@yarnpkg/fslib';
import {VirtualFS, xfs, FakeFS, NativePath}                                 from '@yarnpkg/fslib';
import {ZipOpenFS}                                                          from '@yarnpkg/libzip';
import {buildNodeModulesTree}                                               from '@yarnpkg/nm';
import {NodeModulesLocatorMap, buildLocatorMap, NodeModulesHoistingLimits}  from '@yarnpkg/nm';
import {parseSyml}                                                          from '@yarnpkg/parsers';
import {jsInstallUtils}                                                     from '@yarnpkg/plugin-pnp';
import {PnpApi, PackageInformation}                                         from '@yarnpkg/pnp';
import cmdShim                                                              from '@zkochan/cmd-shim';
import {UsageError}                                                         from 'clipanion';
import crypto                                                               from 'crypto';
import fs                                                                   from 'fs';

const STATE_FILE_VERSION = 1;
const NODE_MODULES = `node_modules` as Filename;
const DOT_BIN = `.bin` as Filename;
const INSTALL_STATE_FILE = `.yarn-state.yml` as Filename;
const MTIME_ACCURANCY = 1000;

type InstallState = {locatorMap: NodeModulesLocatorMap, locationTree: LocationTree, binSymlinks: BinSymlinkMap, nmMode: NodeModulesMode, mtimeMs: number};
type BinSymlinkMap = Map<PortablePath, Map<Filename, PortablePath>>;
type LoadManifest = (locator: LocatorKey, installLocation: PortablePath) => Promise<Pick<Manifest, `bin`>>;

export enum NodeModulesMode {
  CLASSIC = `classic`,
  HARDLINKS_LOCAL = `hardlinks-local`,
  HARDLINKS_GLOBAL = `hardlinks-global`,
}

export class NodeModulesLinker implements Linker {
  private installStateCache: Map<string, Promise<InstallState | null>> = new Map();

  getCustomDataKey() {
    return JSON.stringify({
      name: `NodeModulesLinker`,
      version: 3,
    });
  }

  supportsPackage(pkg: Package, opts: MinimalLinkOptions) {
    return this.isEnabled(opts);
  }

  async findPackageLocation(locator: Locator, opts: LinkOptions) {
    if (!this.isEnabled(opts))
      throw new Error(`Assertion failed: Expected the node-modules linker to be enabled`);

    const workspace = opts.project.tryWorkspaceByLocator(locator);
    if (workspace)
      return workspace.cwd;

    const installState = await miscUtils.getFactoryWithDefault(this.installStateCache, opts.project.cwd, async () => {
      return await findInstallState(opts.project, {unrollAliases: true});
    });

    if (installState === null)
      throw new UsageError(`Couldn't find the node_modules state file - running an install might help (findPackageLocation)`);

    const locatorInfo = installState.locatorMap.get(structUtils.stringifyLocator(locator));
    if (!locatorInfo) {
      const err = new UsageError(`Couldn't find ${structUtils.prettyLocator(opts.project.configuration, locator)} in the currently installed node_modules map - running an install might help`);
      (err as any).code = `LOCATOR_NOT_INSTALLED`;
      throw err;
    }

    // Sort locations from shallowest to deepest in terms of directory nesting
    const sortedLocations = locatorInfo.locations.sort((loc1, loc2) => loc1.split(ppath.sep).length - loc2.split(ppath.sep).length);
    // Find the location with shallowest directory nesting that starts inside node_modules of cwd
    const startingCwdModules = ppath.join(opts.project.configuration.startingCwd, NODE_MODULES);
    return sortedLocations.find(location => ppath.contains(startingCwdModules, location)) || locatorInfo.locations[0];
  }

  async findPackageLocator(location: PortablePath, opts: LinkOptions) {
    if (!this.isEnabled(opts))
      return null;

    const installState = await miscUtils.getFactoryWithDefault(this.installStateCache, opts.project.cwd, async () => {
      return await findInstallState(opts.project, {unrollAliases: true});
    });

    if (installState === null)
      return null;

    const {locationRoot, segments} = parseLocation(ppath.resolve(location), {skipPrefix: opts.project.cwd});

    let locationNode = installState.locationTree.get(locationRoot);
    if (!locationNode)
      return null;

    let locator = locationNode.locator!;
    for (const segment of segments) {
      locationNode = locationNode.children.get(segment);
      if (!locationNode)
        break;
      locator = locationNode.locator || locator;
    }

    return structUtils.parseLocator(locator);
  }

  makeInstaller(opts: LinkOptions) {
    return new NodeModulesInstaller(opts);
  }

  private isEnabled(opts: MinimalLinkOptions) {
    return opts.project.configuration.get(`nodeLinker`) === `node-modules`;
  }
}

class NodeModulesInstaller implements Installer {
  // Stores data that we need to extract in the `installPackage` step but use
  // in the `finalizeInstall` step. Contrary to custom data this isn't persisted
  // anywhere - we literally just use it for the lifetime of the installer then
  // discard it.
  private localStore: Map<LocatorHash, {
    pkg: Package;
    customPackageData: CustomPackageData;
    dependencyMeta: DependencyMeta;
    pnpNode: PackageInformation<NativePath>;
  }> = new Map();

  private realLocatorChecksums: Map<LocatorHash, string | null> = new Map();

  constructor(private opts: LinkOptions) {
    // Nothing to do
  }

  private customData: {
    store: Map<LocatorHash, CustomPackageData>;
  } = {
      store: new Map(),
    };

  attachCustomData(customData: any) {
    this.customData = customData;
  }

  async installPackage(pkg: Package, fetchResult: FetchResult) {
    const packageLocation = ppath.resolve(fetchResult.packageFs.getRealPath(), fetchResult.prefixPath);

    let customPackageData = this.customData.store.get(pkg.locatorHash);
    if (typeof customPackageData === `undefined`) {
      customPackageData = await extractCustomPackageData(pkg, fetchResult);
      if (pkg.linkType === LinkType.HARD) {
        this.customData.store.set(pkg.locatorHash, customPackageData);
      }
    }

    // We don't link the package at all if it's for an unsupported platform
    if (!structUtils.isPackageCompatible(pkg, this.opts.project.configuration.getSupportedArchitectures()))
      return {packageLocation: null, buildRequest: null};

    const packageDependencies = new Map<string, string | [string, string] | null>();
    const packagePeers = new Set<string>();

    if (!packageDependencies.has(structUtils.stringifyIdent(pkg)))
      packageDependencies.set(structUtils.stringifyIdent(pkg), pkg.reference);

    let realLocator: Locator = pkg;
    // Only virtual packages should have effective peer dependencies, but the
    // workspaces are a special case because the original packages are kept in
    // the dependency tree even after being virtualized; so in their case we
    // just ignore their declared peer dependencies.
    if (structUtils.isVirtualLocator(pkg)) {
      realLocator = structUtils.devirtualizeLocator(pkg);
      for (const descriptor of pkg.peerDependencies.values()) {
        packageDependencies.set(structUtils.stringifyIdent(descriptor), null);
        packagePeers.add(structUtils.stringifyIdent(descriptor));
      }
    }

    const pnpNode: PackageInformation<NativePath> = {
      packageLocation: `${npath.fromPortablePath(packageLocation)}/`,
      packageDependencies,
      packagePeers,
      linkType: pkg.linkType,
      discardFromLookup: fetchResult.discardFromLookup ?? false,
    };

    this.localStore.set(pkg.locatorHash, {
      pkg,
      customPackageData,
      dependencyMeta: this.opts.project.getDependencyMeta(pkg, pkg.version),
      pnpNode,
    });

    // We need ZIP contents checksum for CAS addressing purposes, so we need to strip cache key from checksum here
    const checksum = fetchResult.checksum ? fetchResult.checksum.substring(fetchResult.checksum.indexOf(`/`) + 1) : null;
    this.realLocatorChecksums.set(realLocator.locatorHash, checksum);

    return {
      packageLocation,
      buildRequest: null,
    };
  }

  async attachInternalDependencies(locator: Locator, dependencies: Array<[Descriptor, Locator]>) {
    const slot = this.localStore.get(locator.locatorHash);
    if (typeof slot === `undefined`)
      throw new Error(`Assertion failed: Expected information object to have been registered`);

    for (const [descriptor, locator] of dependencies) {
      const target = !structUtils.areIdentsEqual(descriptor, locator)
        ? [structUtils.stringifyIdent(locator), locator.reference] as [string, string]
        : locator.reference;

      slot.pnpNode.packageDependencies.set(structUtils.stringifyIdent(descriptor), target);
    }
  }

  async attachExternalDependents(locator: Locator, dependentPaths: Array<PortablePath>) {
    throw new Error(`External dependencies haven't been implemented for the node-modules linker`);
  }

  async finalizeInstall() {
    if (this.opts.project.configuration.get(`nodeLinker`) !== `node-modules`)
      return undefined;

    const defaultFsLayer = new VirtualFS({
      baseFs: new ZipOpenFS({
        maxOpenFiles: 80,
        readOnlyArchives: true,
      }),
    });

    let preinstallState = await findInstallState(this.opts.project);
    const nmModeSetting = this.opts.project.configuration.get(`nmMode`);

    // Remove build state as well, to force rebuild of all the packages
    if (preinstallState === null || nmModeSetting !== preinstallState.nmMode) {
      this.opts.project.storedBuildState.clear();

      preinstallState = {locatorMap: new Map(), binSymlinks: new Map(), locationTree: new Map(), nmMode: nmModeSetting, mtimeMs: 0};
    }

    const hoistingLimitsByCwd = new Map(this.opts.project.workspaces.map(workspace => {
      let hoistingLimits = this.opts.project.configuration.get(`nmHoistingLimits`);
      try {
        hoistingLimits = miscUtils.validateEnum(NodeModulesHoistingLimits, workspace.manifest.installConfig?.hoistingLimits ?? hoistingLimits);
      } catch {
        const workspaceName = structUtils.prettyWorkspace(this.opts.project.configuration, workspace);
        this.opts.report.reportWarning(MessageName.INVALID_MANIFEST, `${workspaceName}: Invalid 'installConfig.hoistingLimits' value. Expected one of ${Object.values(NodeModulesHoistingLimits).join(`, `)}, using default: "${hoistingLimits}"`);
      }
      return [workspace.relativeCwd, hoistingLimits];
    }));

    const selfReferencesByCwd = new Map(this.opts.project.workspaces.map(workspace => {
      let selfReferences = this.opts.project.configuration.get(`nmSelfReferences`);
      selfReferences = workspace.manifest.installConfig?.selfReferences ?? selfReferences;
      return [workspace.relativeCwd, selfReferences];
    }));

    const pnpApi: PnpApi = {
      VERSIONS: {
        std: 1,
      },
      topLevel: {
        name: null,
        reference: null,
      },
      getLocator: (name, referencish) => {
        if (Array.isArray(referencish)) {
          return {name: referencish[0], reference: referencish[1]};
        } else {
          return {name, reference: referencish};
        }
      },
      getDependencyTreeRoots: () => {
        return this.opts.project.workspaces.map(workspace => {
          const anchoredLocator = workspace.anchoredLocator;
          return {name: structUtils.stringifyIdent(anchoredLocator), reference: anchoredLocator.reference};
        });
      },
      getPackageInformation: pnpLocator => {
        const locator = pnpLocator.reference === null
          ? this.opts.project.topLevelWorkspace.anchoredLocator
          : structUtils.makeLocator(structUtils.parseIdent(pnpLocator.name), pnpLocator.reference);

        const slot = this.localStore.get(locator.locatorHash);
        if (typeof slot === `undefined`)
          throw new Error(`Assertion failed: Expected the package reference to have been registered`);

        return slot.pnpNode;
      },
      findPackageLocator: location => {
        const workspace = this.opts.project.tryWorkspaceByCwd(npath.toPortablePath(location));
        if (workspace !== null) {
          const anchoredLocator = workspace.anchoredLocator;
          return {name: structUtils.stringifyIdent(anchoredLocator), reference: anchoredLocator.reference};
        }

        throw new Error(`Assertion failed: Unimplemented`);
      },
      resolveToUnqualified: () => {
        throw new Error(`Assertion failed: Unimplemented`);
      },
      resolveUnqualified: () => {
        throw new Error(`Assertion failed: Unimplemented`);
      },
      resolveRequest: () => {
        throw new Error(`Assertion failed: Unimplemented`);
      },
      resolveVirtual: path => {
        return npath.fromPortablePath(VirtualFS.resolveVirtual(npath.toPortablePath(path)));
      },
    };

    const {tree, errors, preserveSymlinksRequired} = buildNodeModulesTree(pnpApi, {pnpifyFs: false, validateExternalSoftLinks: true, hoistingLimitsByCwd, project: this.opts.project, selfReferencesByCwd});
    if (!tree) {
      for (const {messageName, text} of errors)
        this.opts.report.reportError(messageName, text);

      return undefined;
    }
    const locatorMap = buildLocatorMap(tree);

    await persistNodeModules(preinstallState, locatorMap, {
      baseFs: defaultFsLayer,
      project: this.opts.project,
      report: this.opts.report,
      realLocatorChecksums: this.realLocatorChecksums,
      loadManifest: async locatorKey => {
        const locator = structUtils.parseLocator(locatorKey);

        const slot = this.localStore.get(locator.locatorHash);
        if (typeof slot === `undefined`)
          throw new Error(`Assertion failed: Expected the slot to exist`);

        return slot.customPackageData.manifest;
      },
    });

    const installStatuses: Array<FinalizeInstallStatus> = [];

    for (const [locatorKey, installRecord] of locatorMap.entries()) {
      if (isLinkLocator(locatorKey))
        continue;

      const locator = structUtils.parseLocator(locatorKey);
      const slot = this.localStore.get(locator.locatorHash);
      if (typeof slot === `undefined`)
        throw new Error(`Assertion failed: Expected the slot to exist`);

      // Workspaces are built by the core
      if (this.opts.project.tryWorkspaceByLocator(slot.pkg))
        continue;

      const buildRequest = jsInstallUtils.extractBuildRequest(slot.pkg, slot.customPackageData, slot.dependencyMeta, {configuration: this.opts.project.configuration});
      if (!buildRequest)
        continue;

      installStatuses.push({
        buildLocations: installRecord.locations,
        locator,
        buildRequest,
      });
    }

    if (preserveSymlinksRequired)
      this.opts.report.reportWarning(MessageName.NM_PRESERVE_SYMLINKS_REQUIRED, `The application uses portals and that's why ${formatUtils.pretty(this.opts.project.configuration, `--preserve-symlinks`, formatUtils.Type.CODE)} Node option is required for launching it`);

    return {
      customData: this.customData,
      records: installStatuses,
    };
  }
}


type UnboxPromise<T extends Promise<any>> = T extends Promise<infer U> ? U : never;
type CustomPackageData = UnboxPromise<ReturnType<typeof extractCustomPackageData>>;

async function extractCustomPackageData(pkg: Package, fetchResult: FetchResult) {
  const manifest = await Manifest.tryFind(fetchResult.prefixPath, {baseFs: fetchResult.packageFs}) ?? new Manifest();

  const preservedScripts = new Set([`preinstall`, `install`, `postinstall`]);
  for (const scriptName of manifest.scripts.keys())
    if (!preservedScripts.has(scriptName))
      manifest.scripts.delete(scriptName);

  return {
    manifest: {
      bin: manifest.bin,
      scripts: manifest.scripts,
    },
    misc: {
      hasBindingGyp: jsInstallUtils.hasBindingGyp(fetchResult),
    },
  };
}

async function writeInstallState(project: Project, locatorMap: NodeModulesLocatorMap, binSymlinks: BinSymlinkMap, nmMode: {value: NodeModulesMode}, {installChangedByUser}: {installChangedByUser: boolean}) {
  let locatorState = ``;

  locatorState += `# Warning: This file is automatically generated. Removing it is fine, but will\n`;
  locatorState += `# cause your node_modules installation to become invalidated.\n`;
  locatorState += `\n`;
  locatorState += `__metadata:\n`;
  locatorState += `  version: ${STATE_FILE_VERSION}\n`;
  locatorState += `  nmMode: ${nmMode.value}\n`;

  const locators = Array.from(locatorMap.keys()).sort();
  const topLevelLocator = structUtils.stringifyLocator(project.topLevelWorkspace.anchoredLocator);

  for (const locator of locators) {
    const installRecord = locatorMap.get(locator)!;
    locatorState += `\n`;
    locatorState += `${JSON.stringify(locator)}:\n`;
    locatorState += `  locations:\n`;

    for (const location of installRecord.locations) {
      const internalPath = ppath.contains(project.cwd, location);
      if (internalPath === null)
        throw new Error(`Assertion failed: Expected the path to be within the project (${location})`);

      locatorState += `    - ${JSON.stringify(internalPath)}\n`;
    }

    if (installRecord.aliases.length > 0) {
      locatorState += `  aliases:\n`;
      for (const alias of installRecord.aliases) {
        locatorState += `    - ${JSON.stringify(alias)}\n`;
      }
    }

    if (locator === topLevelLocator && binSymlinks.size > 0) {
      locatorState += `  bin:\n`;
      for (const [location, symlinks] of binSymlinks) {
        const internalPath = ppath.contains(project.cwd, location);
        if (internalPath === null)
          throw new Error(`Assertion failed: Expected the path to be within the project (${location})`);

        locatorState += `    ${JSON.stringify(internalPath)}:\n`;
        for (const [name, target] of symlinks) {
          const relativePath = ppath.relative(ppath.join(location, NODE_MODULES), target);
          locatorState += `      ${JSON.stringify(name)}: ${JSON.stringify(relativePath)}\n`;
        }
      }
    }
  }

  const rootPath = project.cwd;
  const installStatePath = ppath.join(rootPath, NODE_MODULES, INSTALL_STATE_FILE);

  // Force install state file rewrite, so that it has mtime bigger than all node_modules subfolders
  if (installChangedByUser)
    await xfs.removePromise(installStatePath);

  await xfs.changeFilePromise(installStatePath, locatorState, {
    automaticNewlines: true,
  });
}

async function findInstallState(project: Project, {unrollAliases = false}: {unrollAliases?: boolean} = {}): Promise<InstallState | null> {
  const rootPath = project.cwd;
  const installStatePath = ppath.join(rootPath, NODE_MODULES, INSTALL_STATE_FILE);

  let stats;
  try {
    stats = await xfs.statPromise(installStatePath);
  } catch {
  }

  if (!stats)
    return null;

  const locatorState = parseSyml(await xfs.readFilePromise(installStatePath, `utf8`));

  // If we have a higher serialized version than we can handle, ignore the state alltogether
  if (locatorState.__metadata.version > STATE_FILE_VERSION)
    return null;

  const nmMode = locatorState.__metadata.nmMode || NodeModulesMode.CLASSIC;

  const locatorMap: NodeModulesLocatorMap = new Map();
  const binSymlinks: BinSymlinkMap = new Map();

  delete locatorState.__metadata;

  for (const [locatorStr, installRecord] of Object.entries(locatorState)) {
    const locations = installRecord.locations.map((location: PortablePath) => {
      return ppath.join(rootPath, location);
    });

    const recordSymlinks = installRecord.bin;
    if (recordSymlinks) {
      for (const [relativeLocation, locationSymlinks] of Object.entries(recordSymlinks)) {
        const location = ppath.join(rootPath, npath.toPortablePath(relativeLocation));
        const symlinks = miscUtils.getMapWithDefault(binSymlinks, location);
        for (const [name, target] of Object.entries(locationSymlinks as any)) {
          symlinks.set(name as Filename, npath.toPortablePath([location, NODE_MODULES, target].join(ppath.sep)));
        }
      }
    }

    locatorMap.set(locatorStr, {
      target: PortablePath.dot,
      linkType: LinkType.HARD,
      locations,
      aliases: installRecord.aliases || [],
    });

    if (unrollAliases && installRecord.aliases) {
      for (const reference of installRecord.aliases) {
        const {scope, name} = structUtils.parseLocator(locatorStr);

        const alias = structUtils.makeLocator(structUtils.makeIdent(scope, name), reference);
        const aliasStr = structUtils.stringifyLocator(alias);

        locatorMap.set(aliasStr, {
          target: PortablePath.dot,
          linkType: LinkType.HARD,
          locations,
          aliases: [],
        });
      }
    }
  }

  return {locatorMap, binSymlinks, locationTree: buildLocationTree(locatorMap, {skipPrefix: project.cwd}), nmMode, mtimeMs: stats.mtimeMs};
}

const removeDir = async (dir: PortablePath, options: {contentsOnly: boolean, innerLoop?: boolean, isWorkspaceDir?: boolean}): Promise<any> => {
  if (dir.split(ppath.sep).indexOf(NODE_MODULES) < 0)
    throw new Error(`Assertion failed: trying to remove dir that doesn't contain node_modules: ${dir}`);

  try {
    let dirStats;
    if (!options.innerLoop) {
      dirStats = await xfs.lstatPromise(dir);
      if ((!dirStats.isDirectory() && !dirStats.isSymbolicLink()) || (dirStats.isSymbolicLink() && !options.isWorkspaceDir)) {
        await xfs.unlinkPromise(dir);
        return;
      }
    }
    const entries = await xfs.readdirPromise(dir, {withFileTypes: true});
    for (const entry of entries) {
      const targetPath = ppath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== NODE_MODULES || (options && options.innerLoop)) {
          await removeDir(targetPath, {innerLoop: true, contentsOnly: false});
        }
      } else {
        await xfs.unlinkPromise(targetPath);
      }
    }

    const isExternalWorkspaceSymlink = !options.innerLoop && options.isWorkspaceDir && dirStats?.isSymbolicLink();
    if (!options.contentsOnly && !isExternalWorkspaceSymlink) {
      await xfs.rmdirPromise(dir);
    }
  } catch (e) {
    if (e.code !== `ENOENT` && e.code !== `ENOTEMPTY`) {
      throw e;
    }
  }
};

const CONCURRENT_OPERATION_LIMIT = 4;

type LocatorKey = string;
type LocationNode = {children: Map<Filename, LocationNode>, locator?: LocatorKey, linkType: LinkType};
type LocationRoot = PortablePath;

/**
 * Locations tree. It starts with the map of location roots and continues as maps
 * of nested directory entries.
 *
 * Example:
 *  Map {
 *   '' => children: Map {
 *     'react-apollo' => {
 *       children: Map {
 *         'node_modules' => {
 *           children: Map {
 *             '@apollo' => {
 *               children: Map {
 *                 'react-hooks' => {
 *                   children: Map {},
 *                   locator: '@apollo/react-hooks:virtual:cf...#npm:3.1.3'
 *                 }
 *               }
 *             }
 *           }
 *         }
 *       },
 *       locator: 'react-apollo:virtual:24...#npm:3.1.3'
 *     },
 *   },
 *   'packages/client' => children: Map {
 *     'node_modules' => Map {
 *       ...
 *     }
 *   }
 *   ...
 * }
 */
type LocationTree = Map<LocationRoot, LocationNode>;

const parseLocation = (location: PortablePath, {skipPrefix}: {skipPrefix: PortablePath}): {locationRoot: PortablePath, segments: Array<Filename>} => {
  const projectRelativePath = ppath.contains(skipPrefix, location);
  if (projectRelativePath === null)
    throw new Error(`Assertion failed: Writing attempt prevented to ${location} which is outside project root: ${skipPrefix}`);

  const allSegments = projectRelativePath
    .split(ppath.sep)
    // Ignore empty segments (after trailing slashes)
    .filter(segment => segment !== ``);
  const nmIndex = allSegments.indexOf(NODE_MODULES);

  // Project path, up until the first node_modules segment
  const relativeRoot = allSegments.slice(0, nmIndex).join(ppath.sep) as PortablePath;
  const locationRoot = ppath.join(skipPrefix, relativeRoot);

  // All segments that follow
  const segments = allSegments.slice(nmIndex) as Array<Filename>;

  return {locationRoot, segments};
};

const buildLocationTree = (locatorMap: NodeModulesLocatorMap | null, {skipPrefix}: {skipPrefix: PortablePath}): LocationTree => {
  const locationTree: LocationTree = new Map();
  if (locatorMap === null)
    return locationTree;

  const makeNode: () => LocationNode = () => ({
    children: new Map(),
    linkType: LinkType.HARD,
  });

  for (const [locator, info] of locatorMap.entries()) {
    if (info.linkType === LinkType.SOFT) {
      const internalPath = ppath.contains(skipPrefix, info.target);
      if (internalPath !== null) {
        const node = miscUtils.getFactoryWithDefault(locationTree, info.target, makeNode);
        node.locator = locator;
        node.linkType = info.linkType;
      }
    }

    for (const location of info.locations) {
      const {locationRoot, segments} = parseLocation(location, {skipPrefix});

      let node = miscUtils.getFactoryWithDefault(locationTree, locationRoot, makeNode);

      for (let idx = 0; idx < segments.length; ++idx) {
        const segment = segments[idx];
        // '.' segment exists only for top-level locator, skip it
        if (segment !== `.`) {
          const nextNode = miscUtils.getFactoryWithDefault(node.children, segment, makeNode);

          node.children.set(segment, nextNode);
          node = nextNode;
        }

        if (idx === segments.length - 1) {
          node.locator = locator;
          node.linkType = info.linkType;
        }
      }
    }
  }

  return locationTree;
};

const symlinkPromise = async (srcPath: PortablePath, dstPath: PortablePath, windowsLinkType: WindowsLinkType) => {
  // use junctions on windows if in classic mode
  if (process.platform === `win32` && windowsLinkType === WindowsLinkType.JUNCTIONS) {
    let stats;
    try {
      stats = await xfs.lstatPromise(srcPath);
    } catch {
    }

    if (!stats || stats.isDirectory()) {
      await xfs.symlinkPromise(srcPath, dstPath, `junction`);
      return;
    }
    // fall through to symlink
  }

  // use symlink if tests for junction case fail
  await xfs.symlinkPromise(ppath.relative(ppath.dirname(dstPath), srcPath), dstPath);
};

async function atomicFileWrite(tmpDir: PortablePath, dstPath: PortablePath, content: Buffer) {
  const tmpPath = ppath.join(tmpDir, `${crypto.randomBytes(16).toString(`hex`)}.tmp`);
  try {
    await xfs.writeFilePromise(tmpPath, content);
    try {
      await xfs.linkPromise(tmpPath, dstPath);
    } catch {
    }
  } finally {
    await xfs.unlinkPromise(tmpPath);
  }
}

async function copyFilePromise({srcPath, dstPath, entry, globalHardlinksStore, baseFs, nmMode}: {srcPath: PortablePath, dstPath: PortablePath, entry: DirEntry, globalHardlinksStore: PortablePath | null, baseFs: FakeFS<PortablePath>, nmMode: {value: NodeModulesMode}}) {
  if (entry.kind === DirEntryKind.FILE) {
    if (nmMode.value === NodeModulesMode.HARDLINKS_GLOBAL && globalHardlinksStore && entry.digest) {
      const contentFilePath = ppath.join(globalHardlinksStore, entry.digest.substring(0, 2) as Filename, `${entry.digest.substring(2)}.dat` as Filename);

      let doesContentFileExist;
      try {
        const stats = await xfs.statPromise(contentFilePath);

        if (stats && (!entry.mtimeMs || stats.mtimeMs > entry.mtimeMs || stats.mtimeMs < entry.mtimeMs - MTIME_ACCURANCY)) {
          const contentDigest = await hashUtils.checksumFile(contentFilePath, {baseFs: xfs, algorithm: `sha1`});
          if (contentDigest !== entry.digest) {
            // If file content was modified by the user, or corrupted, we first move it out of the way
            const tmpPath = ppath.join(globalHardlinksStore, `${crypto.randomBytes(16).toString(`hex`)}.tmp`);
            await xfs.renamePromise(contentFilePath, tmpPath);

            // Then we overwrite the temporary file, thus restorting content of original file in all the linked projects
            const content = await baseFs.readFilePromise(srcPath);
            await xfs.writeFilePromise(tmpPath, content);

            try {
            // Then we try to move content file back on its place, if its still free
            // If we fail here, it means that some other process or thread has created content file
            // And this is okay, we will end up with two content files, but both with original content, unlucky files will have `.tmp` extension
              await xfs.linkPromise(tmpPath, contentFilePath);
              entry.mtimeMs = new Date().getTime();
              await xfs.unlinkPromise(tmpPath);
            } catch {
            }
          } else if (!entry.mtimeMs) {
            entry.mtimeMs = Math.ceil(stats.mtimeMs);
          }
        }

        await xfs.linkPromise(contentFilePath, dstPath);
        doesContentFileExist = true;
      } catch {
        doesContentFileExist = false;
      }

      if (!doesContentFileExist) {
        const content = await baseFs.readFilePromise(srcPath);
        await atomicFileWrite(globalHardlinksStore, contentFilePath, content);
        entry.mtimeMs = new Date().getTime();
        try {
          await xfs.linkPromise(contentFilePath, dstPath);
        } catch (e) {
          if (e && e.code && e.code == `EXDEV`) {
            nmMode.value = NodeModulesMode.HARDLINKS_LOCAL;
            await baseFs.copyFilePromise(srcPath, dstPath);
          }
        }
      }
    } else {
      await baseFs.copyFilePromise(srcPath, dstPath);
    }
    const mode = entry.mode & 0o777;
    // An optimization - files will have rw-r-r permissions (0o644) by default, we can skip chmod for them
    if (mode !== 0o644) {
      await xfs.chmodPromise(dstPath, mode);
    }
  }
}

enum DirEntryKind {
  FILE = `file`, DIRECTORY = `directory`, SYMLINK = `symlink`,
}

type DirEntry = {
  kind: DirEntryKind.FILE;
  mode: number;
  digest?: string;
  mtimeMs?: number;
} | {
  kind: DirEntryKind. DIRECTORY;
} | {
  kind: DirEntryKind.SYMLINK;
  symlinkTo: PortablePath;
};

const copyPromise = async (dstDir: PortablePath, srcDir: PortablePath, {baseFs, globalHardlinksStore, nmMode, windowsLinkType: windowsLinkType, packageChecksum}: {baseFs: FakeFS<PortablePath>, globalHardlinksStore: PortablePath | null, nmMode: {value: NodeModulesMode}, windowsLinkType: WindowsLinkType, packageChecksum: string | null}) => {
  await xfs.mkdirPromise(dstDir, {recursive: true});

  const getEntriesRecursive = async (relativePath: PortablePath = PortablePath.dot): Promise<Map<PortablePath, DirEntry>> => {
    const srcPath = ppath.join(srcDir, relativePath);
    const entries = await baseFs.readdirPromise(srcPath, {withFileTypes: true});
    const entryMap = new Map();

    for (const entry of entries) {
      const relativeEntryPath = ppath.join(relativePath, entry.name);
      let entryValue: DirEntry;
      const srcEntryPath = ppath.join(srcPath, entry.name);
      if (entry.isFile()) {
        entryValue = {kind: DirEntryKind.FILE, mode: (await baseFs.lstatPromise(srcEntryPath)).mode};
        if (nmMode.value === NodeModulesMode.HARDLINKS_GLOBAL) {
          const digest = await hashUtils.checksumFile(srcEntryPath, {baseFs, algorithm: `sha1`});
          entryValue.digest = digest;
        }
      } else if (entry.isDirectory()) {
        entryValue = {kind: DirEntryKind.DIRECTORY};
      } else  if (entry.isSymbolicLink()) {
        entryValue = {kind: DirEntryKind.SYMLINK, symlinkTo: await baseFs.readlinkPromise(srcEntryPath)};
      } else {
        throw new Error(`Unsupported file type (file: ${srcEntryPath}, mode: 0o${await baseFs.statSync(srcEntryPath).mode.toString(8).padStart(6, `0`)})`);
      }

      entryMap.set(relativeEntryPath, entryValue);
      if (entry.isDirectory() && relativeEntryPath !== NODE_MODULES) {
        const childEntries = await getEntriesRecursive(relativeEntryPath);
        for (const [childRelativePath, childEntry] of childEntries) {
          entryMap.set(childRelativePath, childEntry);
        }
      }
    }

    return entryMap;
  };

  let allEntries: Map<PortablePath, DirEntry>;
  if (nmMode.value === NodeModulesMode.HARDLINKS_GLOBAL && globalHardlinksStore && packageChecksum) {
    const entriesJsonPath = ppath.join(globalHardlinksStore, packageChecksum.substring(0, 2) as Filename, `${packageChecksum.substring(2)}.json` as Filename);
    try {
      allEntries = new Map(Object.entries(JSON.parse(await xfs.readFilePromise(entriesJsonPath, `utf8`)))) as Map<PortablePath, DirEntry>;
    } catch {
      allEntries = await getEntriesRecursive();
    }
  } else {
    allEntries = await getEntriesRecursive();
  }

  let mtimesChanged = false;
  for (const [relativePath, entry] of allEntries) {
    const srcPath = ppath.join(srcDir, relativePath);
    const dstPath = ppath.join(dstDir, relativePath);
    if (entry.kind === DirEntryKind.DIRECTORY) {
      await xfs.mkdirPromise(dstPath, {recursive: true});
    } else if (entry.kind === DirEntryKind.FILE) {
      const originalMtime = entry.mtimeMs;
      await copyFilePromise({srcPath, dstPath, entry, nmMode, baseFs, globalHardlinksStore});
      if (entry.mtimeMs !== originalMtime) {
        mtimesChanged = true;
      }
    } else if (entry.kind === DirEntryKind.SYMLINK) {
      await symlinkPromise(ppath.resolve(ppath.dirname(dstPath), entry.symlinkTo), dstPath, windowsLinkType);
    }
  }

  if (nmMode.value === NodeModulesMode.HARDLINKS_GLOBAL && globalHardlinksStore && mtimesChanged && packageChecksum) {
    const entriesJsonPath = ppath.join(globalHardlinksStore, packageChecksum.substring(0, 2) as Filename, `${packageChecksum.substring(2)}.json` as Filename);
    await xfs.removePromise(entriesJsonPath);
    await atomicFileWrite(globalHardlinksStore, entriesJsonPath, Buffer.from(JSON.stringify(Object.fromEntries(allEntries))));
  }
};

/**
 * Synchronizes previous install state with the actual directories available on disk
 *
 * @param locationTree location tree
 * @param binSymlinks bin symlinks map
 * @param stateMtimeMs state file timestamp (this file is written after all node_modules files and directories)
 *
 * @returns location tree and bin symlinks with modules, unavailable on disk, removed
 */
function syncPreinstallStateWithDisk(locationTree: LocationTree, binSymlinks: BinSymlinkMap, stateMtimeMs: number, project: Project): {locationTree: LocationTree, binSymlinks: BinSymlinkMap, locatorLocations: Map<LocatorKey, Set<PortablePath>>, installChangedByUser: boolean} {
  const refinedLocationTree: LocationTree = new Map();
  const refinedBinSymlinks = new Map();
  const locatorLocations = new Map();
  let installChangedByUser = false;

  const syncNodeWithDisk = (parentPath: PortablePath, entry: Filename, parentNode: LocationNode, refinedNode: LocationNode, parentDiskEntries: Set<Filename>) => {
    let doesExistOnDisk = true;
    const entryPath = ppath.join(parentPath, entry);
    let childDiskEntries = new Set<Filename>();

    if (entry === NODE_MODULES || entry.startsWith(`@`)) {
      let stats;
      try {
        stats = xfs.statSync(entryPath);
      } catch {}

      doesExistOnDisk = !!stats;

      if (!stats) {
        installChangedByUser = true;
      } else if (stats.mtimeMs > stateMtimeMs) {
        installChangedByUser = true;
        childDiskEntries = new Set(xfs.readdirSync(entryPath));
      } else {
        childDiskEntries = new Set(parentNode.children.get(entry)!.children.keys());
      }

      const binarySymlinks = binSymlinks.get(parentPath);
      if (binarySymlinks) {
        const binPath = ppath.join(parentPath, NODE_MODULES, DOT_BIN);
        let binStats;
        try {
          binStats = xfs.statSync(binPath);
        } catch {}

        if (!binStats) {
          installChangedByUser = true;
        } else if (binStats.mtimeMs > stateMtimeMs) {
          installChangedByUser = true;

          const diskEntries = new Set(xfs.readdirSync(binPath));
          const refinedBinarySymlinks = new Map();
          refinedBinSymlinks.set(parentPath, refinedBinarySymlinks);

          for (const [entry, target] of binarySymlinks) {
            if (diskEntries.has(entry)) {
              refinedBinarySymlinks.set(entry, target);
            }
          }
        } else {
          refinedBinSymlinks.set(parentPath, binarySymlinks);
        }
      }
    } else {
      doesExistOnDisk = parentDiskEntries.has(entry);
    }

    const node = parentNode.children.get(entry)!;
    if (doesExistOnDisk) {
      const {linkType, locator} = node;
      const childRefinedNode = {children: new Map(), linkType, locator};
      refinedNode.children.set(entry, childRefinedNode);
      if (locator) {
        const locations = miscUtils.getSetWithDefault(locatorLocations, locator);
        locations.add(entryPath);
        locatorLocations.set(locator, locations);
      }

      for (const childEntry of node.children.keys()) {
        syncNodeWithDisk(entryPath, childEntry, node, childRefinedNode, childDiskEntries);
      }
    } else if (node.locator) {
      project.storedBuildState.delete(structUtils.parseLocator(node.locator).locatorHash);
    }
  };

  for (const [workspaceRoot, node] of locationTree) {
    const {linkType, locator} = node;
    const refinedNode = {children: new Map(), linkType, locator};
    refinedLocationTree.set(workspaceRoot, refinedNode);
    if (locator) {
      const locations = miscUtils.getSetWithDefault(locatorLocations, node.locator);
      locations.add(workspaceRoot);
      locatorLocations.set(node.locator, locations);
    }

    if (node.children.has(NODE_MODULES)) {
      syncNodeWithDisk(workspaceRoot, NODE_MODULES, node, refinedNode, new Set());
    }
  }

  return {locationTree: refinedLocationTree, binSymlinks: refinedBinSymlinks, locatorLocations, installChangedByUser};
}

function isLinkLocator(locatorKey: LocatorKey): boolean {
  let descriptor = structUtils.parseDescriptor(locatorKey);
  if (structUtils.isVirtualDescriptor(descriptor))
    descriptor = structUtils.devirtualizeDescriptor(descriptor);

  return descriptor.range.startsWith(`link:`);
}

async function createBinSymlinkMap(installState: NodeModulesLocatorMap, locationTree: LocationTree, projectRoot: PortablePath, {loadManifest}: {loadManifest: LoadManifest}) {
  const locatorScriptMap = new Map<LocatorKey, Map<string, string>>();
  for (const [locatorKey, {locations}] of installState) {
    const manifest = !isLinkLocator(locatorKey)
      ? await loadManifest(locatorKey, locations[0])
      : null;

    const bin = new Map();
    if (manifest) {
      for (const [name, value] of manifest.bin) {
        const target = ppath.join(locations[0], value);
        if (value !== `` && xfs.existsSync(target)) {
          bin.set(name, value);
        }
      }
    }

    locatorScriptMap.set(locatorKey, bin);
  }

  const binSymlinks: BinSymlinkMap = new Map();

  const getBinSymlinks = (location: PortablePath, parentLocatorLocation: PortablePath, node: LocationNode): Map<Filename, PortablePath> => {
    const symlinks = new Map();
    const internalPath = ppath.contains(projectRoot, location);
    if (node.locator && internalPath !== null) {
      const binScripts = locatorScriptMap.get(node.locator)!;
      for (const [filename, scriptPath] of binScripts) {
        const symlinkTarget = ppath.join(location, npath.toPortablePath(scriptPath));
        symlinks.set(filename, symlinkTarget);
      }
      for (const [childLocation, childNode] of node.children) {
        const absChildLocation = ppath.join(location, childLocation);
        const childSymlinks = getBinSymlinks(absChildLocation, absChildLocation, childNode);
        if (childSymlinks.size > 0) {
          binSymlinks.set(location, new Map([...(binSymlinks.get(location) || new Map()), ...childSymlinks]));
        }
      }
    } else {
      for (const [childLocation, childNode] of node.children) {
        const childSymlinks = getBinSymlinks(ppath.join(location, childLocation), parentLocatorLocation, childNode);
        for (const [name, symlinkTarget] of childSymlinks) {
          symlinks.set(name, symlinkTarget);
        }
      }
    }
    return symlinks;
  };

  for (const [location, node] of locationTree) {
    const symlinks = getBinSymlinks(location, location, node);
    if (symlinks.size > 0) {
      binSymlinks.set(location, new Map([...(binSymlinks.get(location) || new Map()), ...symlinks]));
    }
  }

  return binSymlinks;
}

const areRealLocatorsEqual = (locatorKey1?: LocatorKey, locatorKey2?: LocatorKey) => {
  if (!locatorKey1 || !locatorKey2)
    return locatorKey1 === locatorKey2;

  let locator1 = structUtils.parseLocator(locatorKey1);
  if (structUtils.isVirtualLocator(locator1))
    locator1 = structUtils.devirtualizeLocator(locator1);
  let locator2 = structUtils.parseLocator(locatorKey2);
  if (structUtils.isVirtualLocator(locator2))
    locator2 = structUtils.devirtualizeLocator(locator2);

  return structUtils.areLocatorsEqual(locator1, locator2);
};

export function getGlobalHardlinksStore(configuration: Configuration): PortablePath {
  return ppath.join(configuration.get(`globalFolder`), `store` as Filename);
}

/**
 * Mutate binSymlinks by removing binaries related to the changedLocations.
 */
function invalidateBinSymlinks(binSymlinks: BinSymlinkMap, changedLocations: Set<PortablePath>): void {
  const getLocationPackageRoot = (targetPath: PortablePath): PortablePath => {
    const parts = targetPath.split(ppath.sep);
    const nmIndex = parts.lastIndexOf(NODE_MODULES);
    if (nmIndex < 0 || nmIndex == parts.length - 1)
      throw new Error(`Assertion failed. Path is outside of any node_modules package ${targetPath}`);

    return parts.slice(0, nmIndex + (parts[nmIndex + 1].startsWith(`@`) ? 3 : 2)).join(ppath.sep) as PortablePath;
  };

  for (const binSymlinkMap of binSymlinks.values()) {
    for (const [binFile, binLocation] of binSymlinkMap) {
      if (changedLocations.has(getLocationPackageRoot(binLocation))) {
        binSymlinkMap.delete(binFile);
      }
    }
  }
}

async function persistNodeModules(preinstallState: InstallState, installState: NodeModulesLocatorMap, {baseFs, project, report, loadManifest, realLocatorChecksums}: {project: Project, baseFs: FakeFS<PortablePath>, report: Report, loadManifest: LoadManifest, realLocatorChecksums: Map<LocatorHash, string | null>}) {
  const rootNmDirPath = ppath.join(project.cwd, NODE_MODULES);

  const {
    locationTree: prevLocationTree,
    binSymlinks: prevBinSymlinks,
    locatorLocations: prevLocatorLocations,
    installChangedByUser,
  } = syncPreinstallStateWithDisk(preinstallState.locationTree, preinstallState.binSymlinks, preinstallState.mtimeMs, project);

  const locationTree = buildLocationTree(installState, {skipPrefix: project.cwd});

  const addQueue: Array<Promise<void>> = [];
  const addModule = async ({srcDir, dstDir, linkType, globalHardlinksStore, nmMode, windowsLinkType, packageChecksum}: {srcDir: PortablePath, dstDir: PortablePath, linkType: LinkType, globalHardlinksStore: PortablePath | null, nmMode: {value: NodeModulesMode},  windowsLinkType: WindowsLinkType, packageChecksum: string | null}) => {
    const promise: Promise<any> = (async () => {
      try {
        if (linkType === LinkType.SOFT) {
          await xfs.mkdirPromise(ppath.dirname(dstDir), {recursive: true});
          await symlinkPromise(ppath.resolve(srcDir), dstDir, windowsLinkType);
        } else {
          await copyPromise(dstDir, srcDir, {baseFs, globalHardlinksStore, nmMode, windowsLinkType, packageChecksum});
        }
      } catch (e) {
        e.message = `While persisting ${srcDir} -> ${dstDir} ${e.message}`;
        throw e;
      } finally {
        progress.tick();
      }
    })().then(() => addQueue.splice(addQueue.indexOf(promise), 1));
    addQueue.push(promise);
    if (addQueue.length > CONCURRENT_OPERATION_LIMIT) {
      await Promise.race(addQueue);
    }
  };

  const cloneModule = async (srcDir: PortablePath, dstDir: PortablePath, options: {nmMode: {value: NodeModulesMode}, innerLoop?: boolean}) => {
    const promise: Promise<any> = (async () => {
      const cloneDir = async (srcDir: PortablePath, dstDir: PortablePath, options: {nmMode: {value: NodeModulesMode}, innerLoop?: boolean}) => {
        try {
          if (!options.innerLoop)
            await xfs.mkdirPromise(dstDir, {recursive: true});

          const entries = await xfs.readdirPromise(srcDir, {withFileTypes: true});
          for (const entry of entries) {
            if ((!options.innerLoop) && entry.name === DOT_BIN)
              continue;

            const src = ppath.join(srcDir, entry.name);
            const dst = ppath.join(dstDir, entry.name);

            if (entry.isDirectory()) {
              if (entry.name !== NODE_MODULES || (options && options.innerLoop)) {
                await xfs.mkdirPromise(dst, {recursive: true});
                await cloneDir(src, dst, {...options, innerLoop: true});
              }
            } else {
              if (nmMode.value === NodeModulesMode.HARDLINKS_LOCAL || nmMode.value === NodeModulesMode.HARDLINKS_GLOBAL) {
                await xfs.linkPromise(src, dst);
              } else {
                await xfs.copyFilePromise(src, dst, fs.constants.COPYFILE_FICLONE);
              }
            }
          }
        } catch (e) {
          if (!options.innerLoop)
            e.message = `While cloning ${srcDir} -> ${dstDir} ${e.message}`;

          throw e;
        } finally {
          if (!options.innerLoop) {
            progress.tick();
          }
        }
      };

      await cloneDir(srcDir, dstDir, options);
    })().then(() => addQueue.splice(addQueue.indexOf(promise), 1));
    addQueue.push(promise);
    if (addQueue.length > CONCURRENT_OPERATION_LIMIT) {
      await Promise.race(addQueue);
    }
  };

  const removeOutdatedDirs = async (location: PortablePath, prevNode: LocationNode, node?: LocationNode) => {
    if (!node) {
      if (prevNode.children.has(NODE_MODULES))
        await removeDir(ppath.join(location, NODE_MODULES), {contentsOnly: false});

      const isWorkspaceNmLocation = ppath.basename(location) === NODE_MODULES && prevLocationTree.has(ppath.join(ppath.dirname(location)));
      await removeDir(location, {contentsOnly: location === rootNmDirPath, isWorkspaceDir: isWorkspaceNmLocation});
    } else {
      for (const [segment, prevChildNode] of prevNode.children) {
        const childNode = node.children.get(segment);
        await removeOutdatedDirs(ppath.join(location, segment), prevChildNode, childNode);
      }
    }
  };

  // Find locations that existed previously, but no longer exist
  for (const [location, prevNode] of prevLocationTree) {
    const node = locationTree.get(location);
    for (const [segment, prevChildNode] of prevNode.children) {
      // '.' segment exists only for top-level locator, skip it
      if (segment === `.`)
        continue;
      const childNode = node ? node.children.get(segment) : node;
      const dirPath = ppath.join(location, segment);
      await removeOutdatedDirs(dirPath, prevChildNode, childNode);
    }
  }

  const cleanNewDirs = async (location: PortablePath, node: LocationNode, prevNode?: LocationNode) => {
    if (!prevNode) {
      // We want to clean only contents of top-level node_modules dir, since we need these dirs to be present
      if (node.children.has(NODE_MODULES))
        await removeDir(ppath.join(location, NODE_MODULES), {contentsOnly: true});

      // 1. If new directory is a symlink, we need to remove it fully
      // 2. If new directory is a hardlink - we just need to clean it up
      const isWorkspaceNmLocation = ppath.basename(location) === NODE_MODULES && locationTree.has(ppath.join(ppath.dirname(location)));
      await removeDir(location, {contentsOnly: node.linkType === LinkType.HARD, isWorkspaceDir: isWorkspaceNmLocation});
    } else {
      if (!areRealLocatorsEqual(node.locator, prevNode.locator))
        await removeDir(location, {contentsOnly: node.linkType === LinkType.HARD});

      for (const [segment, childNode] of node.children) {
        const prevChildNode = prevNode.children.get(segment);
        await cleanNewDirs(ppath.join(location, segment), childNode, prevChildNode);
      }
    }
  };

  // Find new locations that are being added/changed and need to be cleaned up first
  for (const [location, node] of locationTree) {
    const prevNode = prevLocationTree.get(location);
    for (const [segment, childNode] of node.children) {
      // '.' segment exists only for top-level locator, skip it
      if (segment === `.`)
        continue;
      const prevChildNode = prevNode ? prevNode.children.get(segment) : prevNode;
      await cleanNewDirs(ppath.join(location, segment), childNode, prevChildNode);
    }
  }

  const persistedLocations = new Map<PortablePath, PortablePath>();

  // Update changed locations
  const addList: Array<{srcDir: PortablePath, dstDir: PortablePath, linkType: LinkType, realLocatorHash: LocatorHash}> = [];
  for (const [prevLocator, locations] of prevLocatorLocations) {
    for (const location of locations) {
      const {locationRoot, segments} = parseLocation(location, {
        skipPrefix: project.cwd,
      });

      let node = locationTree.get(locationRoot);
      let curLocation = locationRoot;
      if (node) {
        for (const segment of segments) {
          curLocation = ppath.join(curLocation, segment);
          node = node.children.get(segment);
          if (!node) {
            break;
          }
        }
        if (node) {
          const areLocatorsEqual = areRealLocatorsEqual(node.locator, prevLocator);
          const info = installState.get(node.locator!)!;
          const srcDir = info.target;
          const dstDir = curLocation;
          const linkType = info.linkType;
          if (areLocatorsEqual) {
            // Remember the first location for each locator which is already persisted and is not going to be updated
            if (!persistedLocations.has(srcDir)) {
              persistedLocations.set(srcDir, dstDir);
            }
          } else if (srcDir !== dstDir) {
            let realLocator = structUtils.parseLocator(node.locator!);
            if (structUtils.isVirtualLocator(realLocator))
              realLocator = structUtils.devirtualizeLocator(realLocator);
            addList.push({srcDir, dstDir, linkType, realLocatorHash: realLocator.locatorHash});
          }
        }
      }
    }
  }

  // Add new locations
  for (const [locator, {locations}] of installState.entries()) {
    for (const location of locations) {
      const {locationRoot, segments} = parseLocation(location, {
        skipPrefix: project.cwd,
      });

      let prevTreeNode = prevLocationTree.get(locationRoot);
      let node = locationTree.get(locationRoot);
      let curLocation = locationRoot;

      const info = installState.get(locator)!;
      let realLocator = structUtils.parseLocator(locator);
      if (structUtils.isVirtualLocator(realLocator))
        realLocator = structUtils.devirtualizeLocator(realLocator);
      const realLocatorHash = realLocator.locatorHash;
      const srcDir = info.target;
      const dstDir = location;
      if (srcDir === dstDir)
        continue;

      const linkType = info.linkType;

      for (const segment of segments)
        node = node!.children.get(segment);

      if (!prevTreeNode) {
        addList.push({srcDir, dstDir, linkType, realLocatorHash});
      } else {
        for (const segment of segments) {
          curLocation = ppath.join(curLocation, segment);
          prevTreeNode = prevTreeNode.children.get(segment);
          if (!prevTreeNode) {
            addList.push({srcDir, dstDir, linkType, realLocatorHash});
            break;
          }
        }
      }
    }
  }

  const progress = Report.progressViaCounter(addList.length);
  const reportedProgress = report.reportProgress(progress);
  const nmModeSetting = project.configuration.get(`nmMode`);
  const nmMode = {value: nmModeSetting};
  const windowsLinkType = project.configuration.get(`winLinkType`) as WindowsLinkType;

  try {
    // For the first pass we'll only want to install a single copy for each
    // source directory. We'll later use the resulting install directories for
    // the other instances of the same package (this will avoid us having to
    // crawl the zip archives for each package).
    const globalHardlinksStore = nmMode.value === NodeModulesMode.HARDLINKS_GLOBAL ? `${getGlobalHardlinksStore(project.configuration)}/v1` as PortablePath : null;
    if (globalHardlinksStore) {
      if (!await xfs.existsPromise(globalHardlinksStore)) {
        await xfs.mkdirpPromise(globalHardlinksStore);
        for (let idx = 0; idx < 256; idx++) {
          await xfs.mkdirPromise(ppath.join(globalHardlinksStore, idx.toString(16).padStart(2, `0`) as Filename));
        }
      }
    }
    for (const entry of addList) {
      if (entry.linkType === LinkType.SOFT || !persistedLocations.has(entry.srcDir)) {
        persistedLocations.set(entry.srcDir, entry.dstDir);
        await addModule({...entry, globalHardlinksStore, nmMode, windowsLinkType, packageChecksum: realLocatorChecksums.get(entry.realLocatorHash) || null});
      }
    }

    await Promise.all(addQueue);
    addQueue.length = 0;

    // Second pass: clone module duplicates
    for (const entry of addList) {
      const persistedDir = persistedLocations.get(entry.srcDir)!;
      if (entry.linkType !== LinkType.SOFT && entry.dstDir !== persistedDir) {
        await cloneModule(persistedDir, entry.dstDir, {nmMode});
      }
    }

    await Promise.all(addQueue);

    await xfs.mkdirPromise(rootNmDirPath, {recursive: true});

    invalidateBinSymlinks(prevBinSymlinks, new Set(addList.map(l => l.dstDir)));
    const binSymlinks = await createBinSymlinkMap(installState, locationTree, project.cwd, {loadManifest});
    await persistBinSymlinks(prevBinSymlinks, binSymlinks, project.cwd, windowsLinkType);

    await writeInstallState(project, installState, binSymlinks, nmMode, {installChangedByUser});

    if (nmModeSetting == NodeModulesMode.HARDLINKS_GLOBAL && nmMode.value == NodeModulesMode.HARDLINKS_LOCAL) {
      report.reportWarningOnce(MessageName.NM_HARDLINKS_MODE_DOWNGRADED, `'nmMode' has been downgraded to 'hardlinks-local' due to global cache and install folder being on different devices`);
    }
  } finally {
    reportedProgress.stop();
  }
}

async function persistBinSymlinks(previousBinSymlinks: BinSymlinkMap, binSymlinks: BinSymlinkMap, projectCwd: PortablePath, windowsLinkType: WindowsLinkType) {
  // Delete outdated .bin folders
  for (const location of previousBinSymlinks.keys()) {
    if (ppath.contains(projectCwd, location) === null)
      throw new Error(`Assertion failed. Excepted bin symlink location to be inside project dir, instead it was at ${location}`);
    if (!binSymlinks.has(location)) {
      const binDir = ppath.join(location, NODE_MODULES, DOT_BIN);
      await xfs.removePromise(binDir);
    }
  }

  for (const [location, symlinks] of binSymlinks) {
    if (ppath.contains(projectCwd, location) === null)
      throw new Error(`Assertion failed. Excepted bin symlink location to be inside project dir, instead it was at ${location}`);
    const binDir = ppath.join(location, NODE_MODULES, DOT_BIN);
    const prevSymlinks = previousBinSymlinks.get(location) || new Map();
    await xfs.mkdirPromise(binDir, {recursive: true});
    for (const name of prevSymlinks.keys()) {
      if (!symlinks.has(name)) {
        // Remove outdated symlinks
        await xfs.removePromise(ppath.join(binDir, name));
        if (process.platform === `win32`) {
          await xfs.removePromise(ppath.join(binDir, `${name}.cmd`));
        }
      }
    }

    for (const [name, target] of symlinks) {
      const prevTarget = prevSymlinks.get(name);
      const symlinkPath = ppath.join(binDir, name);
      // Skip unchanged .bin symlinks
      if (prevTarget === target)
        continue;

      if (process.platform === `win32`) {
        await cmdShim(npath.fromPortablePath(target), npath.fromPortablePath(symlinkPath), {createPwshFile: false});
      } else {
        await xfs.removePromise(symlinkPath);
        await symlinkPromise(target, symlinkPath, windowsLinkType);
        if (ppath.contains(projectCwd, await xfs.realpathPromise(target)) !== null) {
          await xfs.chmodPromise(target, 0o755);
        }
      }
    }
  }
}
