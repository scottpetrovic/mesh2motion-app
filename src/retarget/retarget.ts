import { Mesh2MotionEngine } from '../Mesh2MotionEngine.ts'
import { type Group, type Scene, Vector3 } from 'three'
import { StepLoadSourceSkeleton } from './steps/StepLoadSourceSkeleton.ts'
import { StepLoadTargetModel } from './steps/StepLoadTargetModel.ts'
import { StepBoneMapping } from './steps/StepBoneMapping.ts'
import { RetargetAnimationPreview } from './RetargetAnimationPreview.ts'
import { RetargetAnimationListing } from './RetargetAnimationListing.ts'
import { AnimationRetargetService } from './AnimationRetargetService'
import { type SkeletonType } from '../lib/enums/SkeletonType.ts'
import { RetargetUtils } from './RetargetUtils.ts'
import { RetargetSessionPersistence } from './RetargetSessionPersistence.ts'

class RetargetModule {
  private readonly mesh2motion_engine: Mesh2MotionEngine
  private readonly step_load_source_skeleton: StepLoadSourceSkeleton
  private readonly step_load_target_model: StepLoadTargetModel
  private readonly step_bone_mapping: StepBoneMapping
  private readonly retarget_animation_preview: RetargetAnimationPreview
  private animation_listing_step: RetargetAnimationListing | null = null
  private readonly session_persistence: RetargetSessionPersistence

  private back_to_bone_map_button: HTMLButtonElement | null = null
  private continue_to_listing_button: HTMLButtonElement | null = null

  constructor () {
    // Set up camera position similar to marketing bootstrap
    this.mesh2motion_engine = new Mesh2MotionEngine()
    const camera_position = new Vector3().set(3, 2, 15)
    this.mesh2motion_engine.set_camera_position(camera_position)

    // Override zoom limits for retargeting to accommodate models of various sizes
    // Allow closer zoom for small details and farther zoom for large models
    // FBX are known to have units with 1 = 1 cm, so things like mixamo will import at 200 units
    // GLB seems to have gone with 1 = 1 meter
    this.mesh2motion_engine.set_zoom_limits(0.1, 1000)

    // Initialize Mesh2Motion skeleton loading step (source)
    this.step_load_source_skeleton = new StepLoadSourceSkeleton(this.mesh2motion_engine.get_scene())

    // Initialize target model loading step
    this.step_load_target_model = new StepLoadTargetModel(this.mesh2motion_engine)

    // Initialize bone mapping step
    this.step_bone_mapping = new StepBoneMapping()

    // Initialize animation preview
    this.retarget_animation_preview = new RetargetAnimationPreview(this.step_bone_mapping)

    this.session_persistence = new RetargetSessionPersistence(
      this.mesh2motion_engine,
      this.step_load_source_skeleton,
      this.step_load_target_model,
      this.step_bone_mapping
    )
  }

  public init (): void {
    this.add_event_listeners()
    this.step_load_source_skeleton.begin()
    this.step_load_target_model.begin()
    this.step_bone_mapping.begin()
    this.retarget_animation_preview.begin()
    this.session_persistence.initialize()
    void this.session_persistence.try_restore()
  }

  public add_event_listeners (): void {
    // create button references
    this.back_to_bone_map_button = document.getElementById('back_to_bone_map_button') as HTMLButtonElement
    const bone_mapping_step = document.getElementById('bone-mapping-step')
    const animation_export_options = document.getElementById('skinned-step-animation-export-options')
    this.continue_to_listing_button = document.getElementById('continue-to-listing-button') as HTMLButtonElement

    this.update_continue_button_state()

    this.back_to_bone_map_button.onclick = () => {
      // Hide the skinned-step-animation-export-options ID and show the bone-mapping-step ID
      if (bone_mapping_step !== null && animation_export_options !== null) {
        animation_export_options.style.display = 'none'
        bone_mapping_step.style.display = 'inline'
      }

      // stop the animation listing step
      if (this.animation_listing_step !== null) {
        this.animation_listing_step.end() // any clean up needed to reset animation listing state
      }

      // start the live preview again and hide the animation player
      this.attempt_start_live_preview()
      this.mesh2motion_engine.show_animation_player(false)
    }

    // Listen for source skeleton (Mesh2Motion) loaded
    this.step_load_source_skeleton.addEventListener('skeleton-loaded', () => {
      // the load step stores the scene and skeleton type internally. grab the data here
      const source_armature: Group = this.step_load_source_skeleton.get_loaded_source_armature() as Group
      const skeleton_type: SkeletonType = this.step_load_source_skeleton.get_skeleton_type()

      // animation service keeps track of shared data across classes
      AnimationRetargetService.getInstance().set_source_armature(source_armature)
      AnimationRetargetService.getInstance().set_skeleton_type(skeleton_type)
      this.mesh2motion_engine.download_settings.update_download_settings_ui_visibility(skeleton_type)

      console.log('Source skeleton loaded:', skeleton_type)

      this.check_for_mesh2motion_retarget()

      this.step_bone_mapping.source_armature_updated()
    })

    // Listen for target model (user-uploaded) loaded
    this.step_load_target_model.addEventListener('target-model-loaded', () => {
      const temp_target_armature: Scene | null = this.step_load_target_model.get_retargetable_meshes()

      if (temp_target_armature == null) {
        console.error('No retargetable meshes found in the uploaded model.')
        return
      }

      AnimationRetargetService.getInstance().set_target_armature(temp_target_armature)

      // if the uploaded model is a M2M rig, we don't need to do any bone mapping
      // hide the bones list and show a message
      this.check_for_mesh2motion_retarget()

      // hide the skeleton helper since we are on that step
      this.step_load_source_skeleton.show_skeleton_helper(false)

      this.attempt_start_live_preview()

      this.update_continue_button_state()
    })

    // listen for bone mapping update events to update continue button state
    this.step_bone_mapping.addEventListener('bone-mappings-changed', () => {
      this.update_continue_button_state()
      this.attempt_start_live_preview()
    })

    // next button to go to the animation listing step
    this.continue_to_listing_button.onclick = () => {
      // Hide the bone-mapping-step ID and show the skinned-step-animation-export-options ID
      if (bone_mapping_step !== null && animation_export_options !== null) {
        bone_mapping_step.style.display = 'none'
        animation_export_options.style.display = 'inline'
      }

      // hide the skeleton helper that is offset since we have committed and are continuing
      this.step_load_source_skeleton.show_skeleton_helper(false)

      // stop the live preview step from playing its animation
      this.retarget_animation_preview.stop_preview()

      // load the animation listing step and start it
      this.animation_listing_step = new RetargetAnimationListing(
        this.mesh2motion_engine.get_theme_manager(),
        this.mesh2motion_engine.download_settings
      )
      this.animation_listing_step.begin()
      this.mesh2motion_engine.download_settings.update_download_settings_ui_visibility(
        AnimationRetargetService.getInstance().get_skeleton_type()
      )
      this.mesh2motion_engine.show_animation_player(true)

      this.animation_listing_step.load_and_apply_default_animation_to_skinned_mesh()
      this.animation_listing_step.start_preview()
    }
  }

  private update_continue_button_state (): void {
    if (this.continue_to_listing_button === null) {
      return
    }

    // variables that control if we enable the continue button and show the tooltip
    const identical_bones: boolean = this.is_source_and_target_rig_identical() // target rig is a M2M rig
    const tooltip_span: HTMLElement | null = document.querySelector('#continue-button-tooltip')
    const has_at_least_one_bone_mapping = this.step_bone_mapping.has_bone_mappings()

    // only show the tooltip if we dont' have any bone mappings to provide guidance to the user
    if (tooltip_span != null) {
      if (has_at_least_one_bone_mapping || identical_bones) {
        tooltip_span.style.display = 'none'
      } else {
        tooltip_span.style.display = 'inline-flex'
      }
    }

    // enable/disable the continue button
    this.continue_to_listing_button.disabled = !(identical_bones || has_at_least_one_bone_mapping)
  }

  // Helps us determine if we are uploading a Mesh2Motion rig
  // we don't need bone mapping for that, so this helps us catch that scenario
  private is_source_and_target_rig_identical (): boolean {
    return RetargetUtils.are_source_and_target_bones_identical(
      AnimationRetargetService.getInstance().get_source_armature(),
      AnimationRetargetService.getInstance().get_target_armature()
    )
  }

  private check_for_mesh2motion_retarget (): void {
    // if the source and target is identical, no need to do bone mapping step
    const identical_bones: boolean = this.is_source_and_target_rig_identical()

    const target_bones_list_container = document.getElementById('target-bones-list-container')
    const no_bone_mapping_needed_message = document.getElementById('no-bone-mapping-needed-message')

    if (target_bones_list_container !== null) {
      target_bones_list_container.style.display = identical_bones ? 'none' : 'block'
    }

    if (no_bone_mapping_needed_message !== null) {
      no_bone_mapping_needed_message.style.display = identical_bones ? 'inline-flex' : 'none'
    }

    // bones are not the same...so we need to do bone mapping
    if (!identical_bones) {
      this.step_bone_mapping.target_armature_updated()
    }
  }

  private attempt_start_live_preview (): void {
    // without mappings the source clip would drive any target bone that happens to share a name
    const has_something_to_retarget: boolean =
      this.step_bone_mapping.has_bone_mappings() || this.is_source_and_target_rig_identical()

    // Only start preview when both skeletons are loaded
    if (this.step_bone_mapping.has_both_skeletons() && has_something_to_retarget) {
      this.retarget_animation_preview.start_preview().catch((error) => {
        // maybe useful if errors happen in the future for debugging
        console.error('Failed to start preview:', error)
      })
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  retarget_app.init()
})

const retarget_app = new RetargetModule()
