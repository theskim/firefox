/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  _ExperimentManager: "resource://nimbus/lib/ExperimentManager.sys.mjs",
  CleanupManager: "resource://normandy/lib/CleanupManager.sys.mjs",
  ExperimentManager: "resource://nimbus/lib/ExperimentManager.sys.mjs",
  FeatureManifest: "resource://nimbus/FeatureManifest.sys.mjs",
  NimbusMigrations: "resource://nimbus/lib/Migrations.sys.mjs",
  NimbusTelemetry: "resource://nimbus/lib/Telemetry.sys.mjs",
  RemoteSettings: "resource://services-settings/remote-settings.sys.mjs",
  RemoteSettingsExperimentLoader:
    "resource://nimbus/lib/RemoteSettingsExperimentLoader.sys.mjs",
  UnenrollmentCause: "resource://nimbus/lib/ExperimentManager.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  const { Logger } = ChromeUtils.importESModule(
    "resource://messaging-system/lib/Logger.sys.mjs"
  );
  return new Logger("ExperimentAPI");
});

const CRASHREPORTER_ENABLED =
  AppConstants.MOZ_CRASHREPORTER && AppConstants.MOZ_APP_NAME !== "thunderbird";

const IS_MAIN_PROCESS =
  Services.appinfo.processType === Services.appinfo.PROCESS_TYPE_DEFAULT;

const UPLOAD_ENABLED_PREF = "datareporting.healthreport.uploadEnabled";
const STUDIES_OPT_OUT_PREF = "app.shield.optoutstudies.enabled";

const COLLECTION_ID_PREF = "messaging-system.rsexperimentloader.collection_id";
const COLLECTION_ID_FALLBACK = "nimbus-desktop-experiments";
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "COLLECTION_ID",
  COLLECTION_ID_PREF,
  COLLECTION_ID_FALLBACK
);

function parseJSON(value) {
  if (value) {
    try {
      return JSON.parse(value);
    } catch (e) {
      console.error(e);
    }
  }
  return null;
}

const experimentBranchAccessor = {
  get: (target, prop) => {
    // Offer an API where we can access `branch.feature.*`.
    // This is a useful shorthand that hides the fact that
    // even single-feature recipes are still represented
    // as an array with 1 item
    if (!(prop in target) && target.features) {
      return target.features.find(f => f.featureId === prop);
    } else if (target.feature?.featureId === prop) {
      // Backwards compatibility for version 1.6.2 and older
      return target.feature;
    }

    return target[prop];
  },
};

let initialized = false;

/**
 * Metadata about an enrollment.
 *
 * @typedef {object} EnrollmentMetadata
 * @property {string} slug
 *           The enrollment slug.
 * @property {string} branch
 *           The slug of the enrolled branch.
 * @property {boolean} isRollout
 *           Whether or not the enrollment is a rollout.
 */

/**
 * Return metadata about an enrollment.
 *
 * @param {object} enrollment
 *        The enrollment.
 *
 * @returns {EnrollmentMetadata}
 *          Metadata about the enrollment.
 */
function _getEnrollmentMetadata(enrollment) {
  return {
    slug: enrollment.slug,
    branch: enrollment.branch.slug,
    isRollout: enrollment.isRollout,
  };
}

/**
 * @typedef {"experiment"|"rollout"} EnrollmentType
 */
export const EnrollmentType = Object.freeze({
  EXPERIMENT: "experiment",
  ROLLOUT: "rollout",
});

export const ExperimentAPI = {
  /**
   * The topic that is notified when either the studies enabled pref or the
   * telemetry enabled pref changes.
   *
   * Consumers can listen for notifications on this topic to react to
   * Nimbus being enabled or disabled.
   */
  get STUDIES_ENABLED_CHANGED() {
    return "nimbus:studies-enabled-changed";
  },

  /**
   * Initialize the ExperimentAPI.
   *
   * This will initialize the ExperimentManager and the
   * RemoteSettingsExperimentLoader. It will also trigger The
   * RemoteSettingsExperimentLoader to update recipes.
   *
   * @param {object} options
   * @param {object?} options.extraContext
   *        Additional context to use in the ExperimentManager's targeting
   *        context.
   * @param {boolean?} options.forceSync
   *        Force the RemoteSettingsExperimentLoader to trigger a RemoteSettings
   *        sync before updating recipes for the first time.
   */
  async init({ extraContext, forceSync = false } = {}) {
    if (!initialized) {
      initialized = true;

      const studiesEnabled = this.studiesEnabled;

      try {
        await this.manager.onStartup(extraContext);
      } catch (e) {
        lazy.log.error("Failed to initialize ExperimentManager:", e);
      }

      try {
        await this._rsLoader.enable({ forceSync });
      } catch (e) {
        lazy.log.error("Failed to enable RemoteSettingsExperimentLoader:", e);
      }

      try {
        await lazy.NimbusMigrations.applyMigrations();
      } catch (e) {
        lazy.log.error("Failed to apply migrations", e);
      }

      if (CRASHREPORTER_ENABLED) {
        this.manager.store.on("update", this._annotateCrashReport);
        this._annotateCrashReport();
      }

      Services.prefs.addObserver(
        UPLOAD_ENABLED_PREF,
        this._onStudiesEnabledChanged
      );
      Services.prefs.addObserver(
        STUDIES_OPT_OUT_PREF,
        this._onStudiesEnabledChanged
      );

      // If Nimbus was disabled between the start of this function and
      // registering the pref observers we have not handled it yet.
      if (studiesEnabled !== this.studiesEnabled) {
        this._onStudiesEnabledChanged();
      }
    }
  },

  /**
   * Return the global ExperimentManager.
   */
  get manager() {
    return this._manager;
  },

  _resetForTests() {
    this._rsLoader.disable();
    this.manager.store.off("update", this._annotateCrashReport);
    initialized = false;
  },

  get studiesEnabled() {
    return (
      Services.prefs.getBoolPref(UPLOAD_ENABLED_PREF, false) &&
      Services.prefs.getBoolPref(STUDIES_OPT_OUT_PREF, false) &&
      Services.policies.isAllowed("Shield")
    );
  },

  /**
   * Wait for the ExperimentAPI to become ready.
   *
   * NB: This method will not initialize the ExperimentAPI. This is intentional
   * and doing so breaks a lot of tests due to enabling the
   * RemoteSettingsExperimentLoader et al.
   *
   * @returns {Promise}
   *          A promise that resolves when the API has synchronized to the main
   *          store
   */
  async ready() {
    return this.manager.store.ready();
  },

  /**
   * Annotate the current crash report with current enrollments.
   */
  _annotateCrashReport() {
    if (!Services.appinfo.crashReporterEnabled) {
      return;
    }

    const activeEnrollments = this.manager.store
      .getAll()
      .filter(e => e.active)
      .map(e => `${e.slug}:${e.branch.slug}`)
      .join(",");

    Services.appinfo.annotateCrashReport(
      "NimbusEnrollments",
      activeEnrollments
    );
  },

  _onStudiesEnabledChanged() {
    if (!this.studiesEnabled) {
      this.manager._handleStudiesOptOut();
    }

    Services.obs.notifyObservers(null, this.STUDIES_ENABLED_CHANGED);
  },

  /**
   * Returns the recipe for a given experiment slug
   *
   * This should noly be called from the main process.
   *
   * Note that the recipe is directly fetched from RemoteSettings, which has
   * all the recipe metadata available without relying on the `this.manager.store`.
   * Therefore, calling this function does not require to call `this.ready()` first.
   *
   * @param slug {String} An experiment identifier
   * @returns {Recipe|undefined} A matching experiment recipe if one is found
   */
  async getRecipe(slug) {
    if (!IS_MAIN_PROCESS) {
      throw new Error(
        "getRecipe() should only be called from the main process"
      );
    }

    let recipe;

    try {
      [recipe] = await this._remoteSettingsClient.get({
        // Do not sync the RS store, let RemoteSettingsExperimentLoader do that
        syncIfEmpty: false,
        filters: { slug },
      });
    } catch (e) {
      // If an error occurs in .get(), an empty list is returned and the destructuring
      // assignment will throw.
      console.error(e);
      recipe = undefined;
    }

    return recipe;
  },

  /**
   * Returns all the branches for a given experiment slug
   *
   * This should only be called from the main process. Like `getRecipe()`,
   * calling this function does not require to call `this.ready()` first.
   *
   * @param slug {String} An experiment identifier
   * @returns {[Branches]|undefined} An array of branches for the given slug
   */
  async getAllBranches(slug) {
    if (!IS_MAIN_PROCESS) {
      throw new Error(
        "getAllBranches() should only be called from the main process"
      );
    }

    const recipe = await this.getRecipe(slug);
    return recipe?.branches.map(
      branch => new Proxy(branch, experimentBranchAccessor)
    );
  },
};

/**
 * Singleton that holds lazy references to _ExperimentFeature instances
 * defined by the FeatureManifest
 */
export const NimbusFeatures = {};

for (let feature in lazy.FeatureManifest) {
  ChromeUtils.defineLazyGetter(NimbusFeatures, feature, () => {
    return new _ExperimentFeature(feature);
  });
}

export class _ExperimentFeature {
  constructor(featureId, manifest) {
    this.featureId = featureId;
    this.prefGetters = {};
    this.manifest = manifest || lazy.FeatureManifest[featureId];
    if (!this.manifest) {
      console.error(
        `No manifest entry for ${featureId}. Please add one to toolkit/components/nimbus/FeatureManifest.yaml`
      );
    }
    this._didSendExposureEvent = false;
    const variables = this.manifest?.variables || {};

    Object.keys(variables).forEach(key => {
      const { type, fallbackPref } = variables[key];
      if (fallbackPref) {
        XPCOMUtils.defineLazyPreferenceGetter(
          this.prefGetters,
          key,
          fallbackPref,
          null,
          () => {
            ExperimentAPI.manager.store._emitFeatureUpdate(
              this.featureId,
              "pref-updated"
            );
          },
          type === "json" ? parseJSON : val => val
        );
      }
    });
  }

  getSetPrefName(variable) {
    const setPref = this.manifest?.variables?.[variable]?.setPref;

    return setPref?.pref ?? setPref ?? undefined;
  }

  getSetPref(variable) {
    return this.manifest?.variables?.[variable]?.setPref;
  }

  getFallbackPrefName(variable) {
    return this.manifest?.variables?.[variable]?.fallbackPref;
  }

  /**
   * Wait for ExperimentStore to load giving access to experiment features that
   * do not have a pref cache
   */
  ready() {
    return ExperimentAPI.ready();
  }

  /**
   * Lookup feature variables in experiments, rollouts, and fallback prefs.
   * @param {{defaultValues?: {[variableName: string]: any}}} options
   * @returns {{[variableName: string]: any}} The feature value
   */
  getAllVariables({ defaultValues = null } = {}) {
    if (this.allowCoenrollment) {
      throw new Error(
        "Co-enrolling features must use the getAllEnrollments API"
      );
    }

    let enrollment = null;
    try {
      enrollment = ExperimentAPI.manager.store.getExperimentForFeature(
        this.featureId
      );
    } catch (e) {
      console.error(e);
    }
    let featureValue = this._getLocalizedValue(enrollment);

    if (typeof featureValue === "undefined") {
      try {
        enrollment = ExperimentAPI.manager.store.getRolloutForFeature(
          this.featureId
        );
      } catch (e) {
        console.error(e);
      }
      featureValue = this._getLocalizedValue(enrollment);
    }

    return {
      ...this.prefGetters,
      ...defaultValues,
      ...featureValue,
    };
  }

  getVariable(variable) {
    if (this.allowCoenrollment) {
      throw new Error(
        "Co-enrolling features must use the getAllEnrollments API"
      );
    }

    if (!this.manifest?.variables?.[variable]) {
      // Only throw in nightly/tests
      if (Cu.isInAutomation || AppConstants.NIGHTLY_BUILD) {
        throw new Error(
          `Nimbus: Warning - variable "${variable}" is not defined in FeatureManifest.yaml`
        );
      }
    }

    // Next, check if an experiment is defined
    let enrollment = null;
    try {
      enrollment = ExperimentAPI.manager.store.getExperimentForFeature(
        this.featureId
      );
    } catch (e) {
      console.error(e);
    }
    let value = this._getLocalizedValue(enrollment, variable);
    if (typeof value !== "undefined") {
      return value;
    }

    // Next, check for a rollout.
    try {
      enrollment = ExperimentAPI.manager.store.getRolloutForFeature(
        this.featureId
      );
    } catch (e) {
      console.error(e);
    }
    value = this._getLocalizedValue(enrollment, variable);
    if (typeof value !== "undefined") {
      return value;
    }

    // Return the default preference value
    const prefName = this.getFallbackPrefName(variable);
    return prefName ? this.prefGetters[variable] : undefined;
  }

  /**
   * Return metadata about the requested enrollment that uses this feature ID.
   *
   * N.B.: This API cannot be used for co-enrolling features. The
   *       `getAllEnrollmentMetadata` API must be used instead.
   *
   * @param {EnrollmentType?} enrollmentType
   *        The type of enrollment that you want metadata for.
   *
   *        If not provided, metadata for the active experiment
   *
   * @returns {EnrollmentMetadata | null}
   *          The metadata for the requested enrollment if one exists, otherwise
   *          null.
   */
  getEnrollmentMetadata(enrollmentType = undefined) {
    if (this.allowCoenrollment) {
      throw new Error(
        "Co-enrolling features must use the getAllEnrollments or getAllEnrollmentMetadata APIs"
      );
    }

    let enrollment = null;

    try {
      if (typeof enrollmentType === "undefined" || enrollmentType === null) {
        enrollment =
          ExperimentAPI.manager.store.getExperimentForFeature(this.featureId) ??
          ExperimentAPI.manager.store.getRolloutForFeature(this.featureId);
      } else {
        switch (enrollmentType) {
          case EnrollmentType.EXPERIMENT:
            enrollment = ExperimentAPI.manager.store.getExperimentForFeature(
              this.featureId
            );
            break;

          case EnrollmentType.ROLLOUT:
            enrollment = ExperimentAPI.manager.store.getRolloutForFeature(
              this.featureId
            );
            break;
        }
      }
    } catch (e) {
      lazy.log.error("Failed to get enrollment metadata:", e);
    }

    if (!enrollment) {
      return null;
    }

    return _getEnrollmentMetadata(enrollment);
  }

  /**
   * Return all active enrollments.
   *
   * @param {object[]}
   *        An array containing metadata and the feature value for every active
   *        enrollment using this feature.
   */
  getAllEnrollments() {
    return ExperimentAPI.manager.store
      .getAll()
      .filter(e => e.active && e.featureIds.includes(this.featureId))
      .map(enrollment => {
        const meta = _getEnrollmentMetadata(enrollment);
        const values = this._getLocalizedValue(enrollment);
        const value = {
          ...this.prefGetters,
          ...values,
        };

        return {
          meta,
          value,
        };
      });
  }

  /**
   * Return metadata for all active enrollments that use this feature.
   *
   * @returns {object[]}
   *          Metadata for each active enrollment, including
   *          - the slug;
   *          - the branch slug; and
   *          - whether or not the enrollment is a rollout.
   */
  getAllEnrollmentMetadata() {
    return ExperimentAPI.manager.store
      .getAll()
      .filter(e => e.active && e.featureIds.includes(this.featureId))
      .map(_getEnrollmentMetadata);
  }

  recordExposureEvent({ once = false, slug } = {}) {
    if (this.allowCoenrollment && typeof slug !== "string") {
      throw new Error("Co-enrolling features must provide slug");
    }

    if (once && this._didSendExposureEvent) {
      return;
    }

    let metadata = null;
    if (this.allowCoenrollment) {
      const enrollment = ExperimentAPI.manager.store.get(slug);
      if (enrollment.active) {
        metadata = _getEnrollmentMetadata(enrollment);
      }
    } else {
      metadata = this.getEnrollmentMetadata();
    }

    // Exposure is only sent if user is enrolled in an experiment or rollout.
    if (metadata) {
      lazy.NimbusTelemetry.recordExposure(
        metadata.slug,
        metadata.branch,
        this.featureId
      );
      this._didSendExposureEvent = true;
    }
  }

  onUpdate(callback) {
    ExperimentAPI.manager.store._onFeatureUpdate(this.featureId, callback);
  }

  offUpdate(callback) {
    ExperimentAPI.manager.store._offFeatureUpdate(this.featureId, callback);
  }

  /**
   * The applications this feature applies to.
   *
   */
  get applications() {
    return this.manifest.applications ?? ["firefox-desktop"];
  }

  get allowCoenrollment() {
    return this.manifest.allowCoenrollment ?? false;
  }

  /**
   * Do recursive locale substitution on the values, if applicable.
   *
   * If there are no localizations provided, the value will be returned as-is.
   *
   * If the value is an object containing an $l10n key, its substitution will be
   * returned.
   *
   * Otherwise, the value will be recursively substituted.
   *
   * @param {unknown} values The values to perform substitutions upon.
   * @param {Record<string, string>} localizations The localization
   *        substitutions for a specific locale.
   * @param {Set<string>?} missingIds An optional set to collect all the IDs of
   *        all missing l10n entries.
   *
   * @returns {any} The values, potentially locale substituted.
   */
  static substituteLocalizations(
    values,
    localizations,
    missingIds = undefined
  ) {
    const result = _ExperimentFeature._substituteLocalizations(
      values,
      localizations,
      missingIds
    );

    if (missingIds?.size) {
      throw new ExperimentLocalizationError(
        lazy.NimbusTelemetry.ValidationFailureReason.L10N_MISSING_ENTRY
      );
    }

    return result;
  }

  /**
   * The implementation of localization substitution.
   *
   * @param {unknown} values The values to perform substitutions upon.
   * @param {Record<string, string>} localizations The localization
   *        substitutions for a specific locale.
   * @param {Set<string>?} missingIds An optional set to collect all the IDs of
   *        all missing l10n entries.
   *
   * @returns {any} The values, potentially locale substituted.
   */
  static _substituteLocalizations(values, localizations, missingIds) {
    // If the recipe is not localized, we don't need to do anything.
    // Likewise, if the value we are attempting to localize is not an object,
    // there is nothing to localize.
    if (
      typeof localizations === "undefined" ||
      typeof values !== "object" ||
      values === null
    ) {
      return values;
    }

    if (Array.isArray(values)) {
      return values.map(value =>
        _ExperimentFeature._substituteLocalizations(
          value,
          localizations,
          missingIds
        )
      );
    }

    const substituted = Object.assign({}, values);

    for (const [key, value] of Object.entries(values)) {
      if (
        key === "$l10n" &&
        typeof value === "object" &&
        value !== null &&
        value?.id
      ) {
        if (!Object.hasOwn(localizations, value.id)) {
          if (missingIds) {
            missingIds.add(value.id);
            break;
          } else {
            throw new ExperimentLocalizationError(
              lazy.NimbusTelemetry.ValidationFailureReason.L10N_MISSING_ENTRY
            );
          }
        }

        return localizations[value.id];
      }

      substituted[key] = _ExperimentFeature._substituteLocalizations(
        value,
        localizations,
        missingIds
      );
    }

    return substituted;
  }

  /**
   * Return a value (or all values) from an enrollment, potentially localized.
   *
   * @param {Enrollment} enrollment - The enrollment to query for the value or values.
   * @param {string?} variable - The name of the variable to query for. If not
   *                             provided, all variables will be returned.
   *
   * @returns {any} The value for the variable(s) in question.
   */
  _getLocalizedValue(enrollment, variable = undefined) {
    if (enrollment) {
      const locale = Services.locale.appLocaleAsBCP47;

      if (
        typeof enrollment.localizations === "object" &&
        enrollment.localizations !== null &&
        (typeof enrollment.localizations[locale] !== "object" ||
          enrollment.localizations[locale] === null)
      ) {
        ExperimentAPI.manager._unenroll(
          enrollment,
          lazy.UnenrollmentCause.fromReason(
            lazy.NimbusTelemetry.UnenrollReason.L10N_MISSING_LOCALE
          )
        );
        return undefined;
      }

      const allValues = lazy._ExperimentManager.getFeatureConfigFromBranch(
        enrollment.branch,
        this.featureId
      )?.value;
      const value =
        typeof variable === "undefined" ? allValues : allValues?.[variable];

      if (typeof value !== "undefined") {
        try {
          return _ExperimentFeature.substituteLocalizations(
            value,
            enrollment.localizations?.[locale]
          );
        } catch (e) {
          // This should never happen.
          if (e instanceof ExperimentLocalizationError) {
            ExperimentAPI.manager._unenroll(
              enrollment,
              lazy.UnenrollmentCause.fromReason(e.reason)
            );
          } else {
            throw e;
          }
        }
      }
    }

    return undefined;
  }
}

ExperimentAPI._annotateCrashReport =
  ExperimentAPI._annotateCrashReport.bind(ExperimentAPI);
ExperimentAPI._onStudiesEnabledChanged =
  ExperimentAPI._onStudiesEnabledChanged.bind(ExperimentAPI);

if (CRASHREPORTER_ENABLED) {
  lazy.CleanupManager.addCleanupHandler(() => {
    if (initialized) {
      ExperimentAPI.manager.store.off(
        "update",
        ExperimentAPI._annotateCrashReport
      );
    }
  });
}

ChromeUtils.defineLazyGetter(ExperimentAPI, "_manager", function () {
  return lazy.ExperimentManager;
});

ChromeUtils.defineLazyGetter(ExperimentAPI, "_rsLoader", function () {
  return lazy.RemoteSettingsExperimentLoader;
});

ChromeUtils.defineLazyGetter(
  ExperimentAPI,
  "_remoteSettingsClient",
  function () {
    return lazy.RemoteSettings(lazy.COLLECTION_ID);
  }
);

class ExperimentLocalizationError extends Error {
  constructor(reason) {
    super(`Localized experiment error (${reason})`);
    this.reason = reason;
  }
}
