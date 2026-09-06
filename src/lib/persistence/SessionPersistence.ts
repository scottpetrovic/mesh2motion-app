import { Quaternion, Vector3 } from 'three'
import { ProcessStep } from '../enums/ProcessStep'
import { SkeletonType } from '../enums/SkeletonType'
import { RigConfig } from '../RigConfig'
import BoneTransformState from '../interfaces/BoneTransformState'
import type { Mesh2MotionEngine } from '../../Mesh2MotionEngine'
import type { AnimationMirrorExportMode } from '../processes/animations-listing/interfaces/AnimationExportSelection'

interface SavedAnimationSelection {
  name: string
  mirror_export_mode: AnimationMirrorExportMode
}

interface SavedSession {
  step: string
  skeleton_type: string
  hand_skeleton_type: string
  skeleton_scale: number
  bone_transforms: Array<{ name: string, position: number[], rotation: number[], scale: number[] }>
  edit_settings: {
    mirror_mode?: boolean
    use_head_weight_correction?: boolean
    head_plane_height?: number
    use_arm_plane_correction?: boolean
    arm_plane_offset?: number
  }
  animation_selections: SavedAnimationSelection[]
  saved_at: number
}

/**
 * Saves enough of the working session (localStorage for state, IndexedDB for
 * the model file) that closing the app and coming back resumes where the user
 * left off. Only active on the create page; the marketing page drives its own
 * flow and never attaches this.
 */
export class SessionPersistence {
  private static readonly state_key = 'mesh2motion-session'
  private static readonly db_name = 'mesh2motion-session'
  private static readonly db_store = 'files'

  private readonly engine: Mesh2MotionEngine
  private is_restoring: boolean = false
  private save_debounce_timer: ReturnType<typeof setTimeout> | null = null

  constructor (engine: Mesh2MotionEngine) {
    this.engine = engine
  }

  public initialize (): void {
    this.engine.load_model_step.addEventListener('modelLoaded', () => {
      if (this.is_restoring) { return }
      void this.store_model_source()
      this.save_state()
    })

    this.engine.edit_skeleton_step.addEventListener('skeletonTransformed', () => {
      if (this.is_restoring) { return }
      this.debounced_save()
    })

    window.addEventListener('beforeunload', () => { this.save_state() })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { this.save_state() }
    })
  }

  public handle_step_completed (): void {
    this.save_state()
  }

  private debounced_save (): void {
    if (this.save_debounce_timer !== null) {
      clearTimeout(this.save_debounce_timer)
    }
    this.save_debounce_timer = setTimeout(() => {
      this.save_debounce_timer = null
      this.save_state()
    }, 500)
  }

  public save_state (): void {
    if (this.is_restoring) { return }

    if (this.engine.process_step === ProcessStep.LoadModel) {
      this.clear_session()
      return
    }

    try {
      const session: SavedSession = {
        step: this.engine.process_step,
        skeleton_type: this.engine.load_skeleton_step.skeleton_type(),
        hand_skeleton_type: this.engine.ui.dom_hand_skeleton_selection?.value ?? '',
        skeleton_scale: this.engine.load_skeleton_step.skeleton_scale(),
        bone_transforms: this.serialize_bone_transforms(),
        edit_settings: {
          mirror_mode: this.engine.edit_skeleton_step.is_mirror_mode_enabled(),
          use_head_weight_correction: this.engine.edit_skeleton_step.use_head_weight_correction(),
          head_plane_height: this.engine.edit_skeleton_step.get_preview_plane_height(),
          use_arm_plane_correction: this.engine.edit_skeleton_step.use_arm_plane_correction(),
          arm_plane_offset: this.engine.edit_skeleton_step.get_arm_plane_offset()
        },
        animation_selections: this.serialize_animation_selections(),
        saved_at: Date.now()
      }
      localStorage.setItem(SessionPersistence.state_key, JSON.stringify(session))
    } catch (error) {
      console.warn('Could not save session state', error)
    }
  }

  public clear_session (): void {
    localStorage.removeItem(SessionPersistence.state_key)
    void this.delete_model_source()
  }

  public async try_restore (): Promise<void> {
    let session: SavedSession | null = null
    try {
      const raw = localStorage.getItem(SessionPersistence.state_key)
      if (raw === null) { return }
      session = JSON.parse(raw) as SavedSession
    } catch (error) {
      console.warn('Saved session is unreadable, starting fresh', error)
      this.clear_session()
      return
    }

    if (session === null || session.step === ProcessStep.LoadModel) { return }

    const model = await this.read_model_source()
    if (model === null || model.data === null || model.data === undefined) { return }

    this.is_restoring = true
    try {
      this.engine.load_model_step.set_source_file_name(model.file_name)

      const on_model_loaded = (): void => {
        this.engine.load_model_step.removeEventListener('modelLoaded', on_model_loaded)
        this.restore_after_model_loaded(session as SavedSession)
      }
      this.engine.load_model_step.addEventListener('modelLoaded', on_model_loaded)
      this.engine.load_model_step.load_model_file(model.data, model.extension)
    } catch (error) {
      console.warn('Session restore failed', error)
      this.is_restoring = false
    }
  }

  private restore_after_model_loaded (session: SavedSession): void {
    const skeleton_type = session.skeleton_type as SkeletonType
    const rig_file = RigConfig.rig_file_for(skeleton_type)

    if (skeleton_type === SkeletonType.None || rig_file === undefined) {
      this.is_restoring = false
      return
    }

    this.engine.load_skeleton_step.restore_skeleton_selection(
      skeleton_type,
      session.hand_skeleton_type ?? '',
      session.skeleton_scale > 0 ? session.skeleton_scale : 1.0
    )

    const on_skeleton_loaded = (): void => {
      this.engine.load_skeleton_step.removeEventListener('skeletonLoaded', on_skeleton_loaded)
      this.restore_after_skeleton_loaded(session)
    }
    this.engine.load_skeleton_step.addEventListener('skeletonLoaded', on_skeleton_loaded)
    this.engine.load_skeleton_step.load_skeleton_file(rig_file)
  }

  private restore_after_skeleton_loaded (session: SavedSession): void {
    try {
      this.restore_edit_settings(session)

      if (Array.isArray(session.bone_transforms) && session.bone_transforms.length > 0) {
        this.engine.edit_skeleton_step.restore_bone_snapshot(this.deserialize_bone_transforms(session.bone_transforms))
      }

      const wants_animations_step = session.step === ProcessStep.AnimationsListing ||
        session.step === ProcessStep.BindPose
      if (wants_animations_step) {
        this.engine.setup_weight_skinning_config()
        this.engine.process_step_changed(ProcessStep.BindPose)
        this.restore_animation_selections(session.animation_selections ?? [])
        return
      }
    } catch (error) {
      console.warn('Session restore failed partway', error)
    }

    this.finish_restore()
  }

  private restore_animation_selections (selections: SavedAnimationSelection[]): void {
    if (selections.length === 0) {
      this.finish_restore()
      return
    }

    let attempts = 0
    const timer = setInterval(() => {
      const search = this.engine.animations_listing_step.animation_search
      const clips_ready = this.engine.animations_listing_step.animation_clips().length > 0
      if (search !== null && clips_ready) {
        clearInterval(timer)
        search.apply_export_selections_by_name(selections)
        this.finish_restore()
      } else if (++attempts > 150) {
        clearInterval(timer)
        this.finish_restore()
      }
    }, 200)
  }

  private finish_restore (): void {
    this.is_restoring = false
    this.save_state()
  }

  private restore_edit_settings (session: SavedSession): void {
    const settings = session.edit_settings ?? {}

    if (typeof settings.mirror_mode === 'boolean') {
      this.engine.edit_skeleton_step.set_mirror_mode_enabled(settings.mirror_mode)
      if (this.engine.ui.dom_mirror_skeleton_checkbox !== null) {
        this.engine.ui.dom_mirror_skeleton_checkbox.checked = settings.mirror_mode
      }
    }
    if (typeof settings.use_head_weight_correction === 'boolean') {
      this.engine.edit_skeleton_step.set_use_head_weight_correction(settings.use_head_weight_correction)
    }
    if (typeof settings.head_plane_height === 'number') {
      this.engine.edit_skeleton_step.set_preview_plane_height(settings.head_plane_height)
    }
    if (typeof settings.use_arm_plane_correction === 'boolean') {
      this.engine.edit_skeleton_step.set_use_arm_plane_correction(settings.use_arm_plane_correction)
      if (this.engine.ui.dom_arm_plane_checkbox !== null) {
        this.engine.ui.dom_arm_plane_checkbox.checked = settings.use_arm_plane_correction
      }
    }
    if (typeof settings.arm_plane_offset === 'number') {
      this.engine.edit_skeleton_step.set_arm_plane_offset(settings.arm_plane_offset)
      if (this.engine.ui.dom_arm_plane_offset_input !== null) {
        this.engine.ui.dom_arm_plane_offset_input.value = String(settings.arm_plane_offset)
      }
    }
  }

  private serialize_bone_transforms (): SavedSession['bone_transforms'] {
    try {
      const skeleton = this.engine.edit_skeleton_step.skeleton()
      if (skeleton?.bones === undefined || skeleton.bones.length === 0) { return [] }
      return skeleton.bones.map((bone) => ({
        name: bone.name,
        position: bone.position.toArray(),
        rotation: bone.quaternion.toArray() as number[],
        scale: bone.scale.toArray()
      }))
    } catch {
      return []
    }
  }

  private deserialize_bone_transforms (saved: SavedSession['bone_transforms']): BoneTransformState[] {
    return saved.map((bone) => new BoneTransformState(
      bone.name,
      new Vector3().fromArray(bone.position),
      new Quaternion().fromArray(bone.rotation),
      new Vector3().fromArray(bone.scale)
    ))
  }

  private serialize_animation_selections (): SavedAnimationSelection[] {
    const search = this.engine.animations_listing_step.animation_search
    if (search === null) { return [] }
    return search.get_selected_animations().map((animation) => ({
      name: animation.name,
      mirror_export_mode: animation.mirror_export_mode ?? 'none'
    }))
  }

  private async open_db (): Promise<IDBDatabase> {
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open(SessionPersistence.db_name, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SessionPersistence.db_store)) {
          request.result.createObjectStore(SessionPersistence.db_store)
        }
      }
      request.onsuccess = () => { resolve(request.result) }
      request.onerror = () => { reject(request.error) }
    })
  }

  private async store_model_source (): Promise<void> {
    try {
      const source = this.engine.load_model_step.model_source_data()
      if (source.data === null) { return }
      const db = await this.open_db()
      const transaction = db.transaction(SessionPersistence.db_store, 'readwrite')
      transaction.objectStore(SessionPersistence.db_store).put(source, 'model')
      db.close()
    } catch (error) {
      console.warn('Could not store model for session restore', error)
    }
  }

  private async read_model_source (): Promise<{ data: string | ArrayBuffer | null, extension: string, file_name: string } | null> {
    try {
      const db = await this.open_db()
      return await new Promise((resolve) => {
        const request = db.transaction(SessionPersistence.db_store, 'readonly')
          .objectStore(SessionPersistence.db_store).get('model')
        request.onsuccess = () => { db.close(); resolve(request.result ?? null) }
        request.onerror = () => { db.close(); resolve(null) }
      })
    } catch {
      return null
    }
  }

  private async delete_model_source (): Promise<void> {
    try {
      const db = await this.open_db()
      db.transaction(SessionPersistence.db_store, 'readwrite')
        .objectStore(SessionPersistence.db_store).delete('model')
      db.close()
    } catch {
    }
  }
}
