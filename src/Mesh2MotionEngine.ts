import * as THREE from 'three'
import { CustomTransformControls } from './lib/components/CustomTransformControls.ts'
import type { CustomViewHelper } from './lib/CustomViewHelper.ts'

import tippy from 'tippy.js'
import './environment.js'
import 'tippy.js/dist/tippy.css' // optional for styling

import { Utility } from './lib/Utilities.ts'
import { Generators } from './lib/Generators.ts'

import { UI } from './lib/UI.ts'

import { StepLoadModel } from './lib/processes/load-model/StepLoadModel.ts'
import { StepLoadSkeleton } from './lib/processes/load-skeleton/StepLoadSkeleton.ts'
import { StepEditSkeleton } from './lib/processes/edit-skeleton/StepEditSkeleton.ts'
import { MeshDragBonePlacement } from './lib/processes/edit-skeleton/MeshDragBonePlacement.ts'
import { StepAnimationsListing } from './lib/processes/animations-listing/StepAnimationsListing.ts'
import { ArmExtensionControl } from './lib/processes/animations-listing/ArmExtensionControl.ts'
import { DownloadSettings } from './lib/processes/export-to-file/DownloadSettings.ts'
import { StepExportToFile } from './lib/processes/export-to-file/StepExportToFile.ts'
import { StepWeightSkin } from './lib/processes/weight-skin/StepWeightSkin.ts'

import { ProcessStep } from './lib/enums/ProcessStep.ts'
import { type Bone, Group, Scene, type Skeleton, type Vector3 } from 'three'

import { SkeletonType } from './lib/enums/SkeletonType.ts'

import { CustomSkeletonHelper } from './lib/CustomSkeletonHelper.ts'
import { EventListeners } from './lib/EventListeners.ts'
import { ModelPreviewDisplay } from './lib/enums/ModelPreviewDisplay.ts'
import { TransformControlType } from './lib/enums/TransformControlType.ts'
import { TransformSpace } from './lib/enums/TransformSpace.ts'
import { ThemeManager } from './lib/ThemeManager.ts'
import { SettingsDropdownManager } from './lib/SettingsDropdownManager.ts'
import { ModalDialog } from './lib/ModalDialog.ts'
import { ModelCleanupUtility } from './lib/processes/load-model/ModelCleanupUtility.ts'
import { SceneEnvironmentManager } from './lib/SceneEnvironmentManager.ts'
import { CameraShake } from './lib/CameraShake.ts'
import { DOMUtilities } from './lib/DOMUtilities.ts'
import { PlatformManager } from './lib/PlatformManager.ts'
import { NetworkStatusManager } from './lib/NetworkStatusManager.ts'
import type { SessionPersistence } from './lib/persistence/SessionPersistence.ts'

export class Mesh2MotionEngine {
  public readonly camera = Generators.create_camera()
  public readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })

  public readonly transform_controls: CustomTransformControls = new CustomTransformControls(this.camera, this.renderer.domElement)
  public is_transform_controls_dragging: boolean = false
  public readonly transform_controls_hover_distance: number = 0.02 // distance to hover over bones to select them
  public is_model_gizmo_active: boolean = false
  public readonly mesh_drag_bone_placement: MeshDragBonePlacement

  public view_helper: CustomViewHelper | undefined // mini 3d view to help orient orthographic views

  // has UI elements on the HTML page that we will reference/use
  public scene: Scene
  public theme_manager: ThemeManager
  public settings_dropdown_manager: SettingsDropdownManager | undefined
  public ui: UI
  public load_model_step: StepLoadModel
  public load_skeleton_step: StepLoadSkeleton
  public edit_skeleton_step: StepEditSkeleton
  public weight_skin_step: StepWeightSkin
  public animations_listing_step: StepAnimationsListing
  public download_settings: DownloadSettings
  public file_export_step: StepExportToFile

  // for looking at specific bones
  public process_step: ProcessStep = ProcessStep.LoadModel
  public session_persistence: SessionPersistence | null = null
  public skeleton_helper: CustomSkeletonHelper | undefined = undefined
  public debugging_visual_object: Group = new Group()

  // when editing the skeleton, what type of mesh will we see
  public mesh_preview_display_type: ModelPreviewDisplay = ModelPreviewDisplay.Textured
  public transform_controls_type: TransformControlType = TransformControlType.Translation
  public transform_space_type: TransformSpace = TransformSpace.Global

  private readonly clock = new THREE.Clock()
  private readonly scene_environment: SceneEnvironmentManager
  private readonly eventListeners: EventListeners
  private readonly camera_shake: CameraShake

  constructor () {
    this.initialize_shared_dom_mounts()

    // this will add a platform CSS file if we are running our desktop app
    new PlatformManager().init();
    new NetworkStatusManager();

    this.eventListeners = new EventListeners(this)
    // helps resolve requestAnimationFrame calling animate() with wrong context
    this.animate = this.animate.bind(this)
    this.camera_shake = new CameraShake(this.camera)

    this.scene = new Scene()
    this.theme_manager = new ThemeManager()
    this.ui = UI.getInstance()
    this.settings_dropdown_manager = undefined

    // setting up steps
    this.load_model_step = new StepLoadModel()
    this.load_skeleton_step = new StepLoadSkeleton(this.scene)
    this.edit_skeleton_step = new StepEditSkeleton()
    this.weight_skin_step = new StepWeightSkin()
    this.animations_listing_step = new StepAnimationsListing(this.theme_manager)
    this.download_settings = new DownloadSettings()
    this.file_export_step = new StepExportToFile()
    this.mesh_drag_bone_placement = new MeshDragBonePlacement(
      this.camera,
      this.edit_skeleton_step,
      this.load_model_step,
      this.weight_skin_step,
      this.transform_controls_hover_distance
    )

    this.scene_environment = new SceneEnvironmentManager(
      this.scene,
      this.renderer,
      this.camera,
      this.transform_controls,
      this.theme_manager,
      this.mesh_drag_bone_placement
    )

    this.settings_dropdown_manager = new SettingsDropdownManager(this.scene_environment)

    this.setup_environment()
    this.eventListeners.addEventListeners()
    this.process_step = this.process_step_changed(ProcessStep.LoadModel)
    this.animate() // start the render loop which will continue rendering the scene
    this.inject_build_version()
    this.setup_tooltips()
  }

  public get_theme_manager(): ThemeManager {
    return this.theme_manager
  }

  /** Eventually make the scene its own singleton/manager class
   * that we can inject into other classes that need it
   */
  public get_scene (): Scene {
    return this.scene
  }

  /* Add this attribute to an HTML element to give it a tooltip */
  private setup_tooltips (): void {
    tippy('[data-tippy-content]', { theme: 'mesh2motion' })
  }

  // for the release, let's just show the first N characters of the commit SHA
  // then the branch we used to build. This comes from Cloudflare build process
  private inject_build_version (): void {
    if (this.ui.dom_build_version !== null) {
      const commit_sha: string = window.CLOUDFLARE_COMMIT_SHA.slice(0, 9)
      const branch: string = window.CLOUDFLARE_BRANCH

      this.ui.dom_build_version.innerHTML = `git:${commit_sha}-${branch}`
    }
  }

  public set_camera_position (position: Vector3): void {
    this.scene_environment.set_camera_position(position)
  }

  /** Trigger a gentle camera shake transition effect. */
  public shake_camera (intensity?: number, duration?: number): void {
    this.camera_shake.start(intensity, duration)
  }

  public set_zoom_limits (min_distance: number, max_distance: number): void {
    this.scene_environment.set_zoom_limits(min_distance, max_distance)
  }

  public set_fog_enabled (enabled: boolean): void {
    this.scene_environment.set_fog_enabled(enabled)
  }

  public enable_orbit_controls (enabled: boolean): void {
    this.scene_environment.enable_orbit_controls(enabled)
  }

  private setup_environment (): void {
    this.scene_environment.setup_environment()
    this.view_helper = this.scene_environment.get_view_helper()
  } // end setup_environment()

  public regenerate_floor_grid (): void {
    this.scene_environment.regenerate_floor_grid()
  }

  public regenerate_skeleton_helper (new_skeleton: Skeleton, helper_name = 'Skeleton Helper'): void {
    // if skeleton helper exists...remove it
    this.dispose_skeleton_helper()

    // no color passed, so bone shapes and joints both use the bone category colors
    this.skeleton_helper = new CustomSkeletonHelper(this.find_skeleton_root_bone(new_skeleton))
    this.skeleton_helper.name = helper_name
    this.scene.add(this.skeleton_helper)
  }

  // Returns the topmost bone whose parent is not also tracked in the skeleton.
  // Using bones[0] directly failed for custom rigs where the exporter stored
  // bones in non-hierarchical order, causing getBoneList to miss every bone
  // outside bones[0]'s subtree.
  private find_skeleton_root_bone (skeleton: Skeleton): Bone {
    const bone_set = new Set<Bone>(skeleton.bones)
    for (const bone of skeleton.bones) {
      if (!bone_set.has(bone.parent as Bone)) {
        return bone
      }
    }
    return skeleton.bones[0]
  }

  /**
   * Takes the current skeleton helper out of the scene and releases its GPU
   * resources. Skipping the dispose leaked a geometry, materials and an
   * instance matrix buffer on every rebuild, and rebuilds happen on every
   * skeleton edit undo/redo.
   */
  private dispose_skeleton_helper (): void {
    if (this.skeleton_helper === undefined) {
      return
    }

    this.scene.remove(this.skeleton_helper)
    this.skeleton_helper.dispose()
    this.skeleton_helper = undefined
  }

  public sync_skeleton_helper_joint_visibility (): void {
    if (this.skeleton_helper === undefined) {
      return
    }

    const is_edit_skeleton_step = this.process_step === ProcessStep.EditSkeleton

    this.skeleton_helper.setJointsVisible(is_edit_skeleton_step)
    this.skeleton_helper.setHideRightSideJoints(
      is_edit_skeleton_step && this.edit_skeleton_step.is_mirror_mode_enabled()
    )
  }

  public update_a_pose_options_visibility (): void {
    ArmExtensionControl.getInstance().set_visible(
      this.load_skeleton_step.skeleton_type() === SkeletonType.Human
    )
  }

  public handle_transform_controls_moving (): void {
    if (this.is_model_gizmo_active) { return }

    const selected_bone: Bone = this.transform_controls.object as Bone

    if (this.edit_skeleton_step.is_mirror_mode_enabled()) {
      this.edit_skeleton_step.apply_mirror_mode(selected_bone, this.transform_controls.getMode())
    }

    if (this.edit_skeleton_step.independent_bone_movement.is_enabled() &&
        this.transform_controls.getMode() === 'translate') {
      const mirror_bone = this.edit_skeleton_step.is_mirror_mode_enabled()
        ? this.edit_skeleton_step.find_mirror_bone(selected_bone)
        : undefined
      this.edit_skeleton_step.independent_bone_movement.apply(selected_bone, mirror_bone)
    }
  }

  // --- Model position gizmo (step 2) ---

  public enable_model_gizmo (): void {
    this.is_model_gizmo_active = true
    this.transform_controls.attach(this.load_model_step.model_meshes())
    this.transform_controls.setMode('translate')
    this.transform_controls.enabled = true
  }

  private bake_and_disable_model_gizmo (): void {
    const mesh_data = this.load_model_step.model_meshes()
    const pos = mesh_data.position
    if (pos.x !== 0 || pos.y !== 0 || pos.z !== 0) {
      ModelCleanupUtility.translate_model_vertices(mesh_data, pos.x, pos.y, pos.z)
      mesh_data.position.set(0, 0, 0)
    }
    this.is_model_gizmo_active = false
    this.transform_controls.detach()
    this.transform_controls.enabled = false
  }

  public handle_mesh_drag_mode_mouse_down (mouse_event: MouseEvent | PointerEvent): boolean {
    return this.mesh_drag_bone_placement.handle_mouse_down(mouse_event)
  }

  public handle_mesh_drag_mode_mouse_move (mouse_event: MouseEvent | PointerEvent): void {
    this.mesh_drag_bone_placement.handle_mouse_move(mouse_event)
  }

  public handle_mesh_drag_mode_mouse_up (): void {
    const did_end_drag = this.mesh_drag_bone_placement.handle_mouse_up()

    if (!did_end_drag) {
      return
    }

    if (this.process_step === ProcessStep.EditSkeleton &&
      this.mesh_preview_display_type === ModelPreviewDisplay.WeightPainted) {
      this.regenerate_weight_painted_preview_mesh()
    }
  }

  public update_edit_bone_interaction_mode (): void {
    this.mesh_drag_bone_placement.sync_interaction_mode(this.process_step, this.transform_controls)
    this.is_transform_controls_dragging = false
  }

  public get is_mesh_drag_mode_dragging (): boolean {
    return this.mesh_drag_bone_placement.is_dragging()
  }

  private update_current_process_step (process_step: ProcessStep): void {
    switch (process_step) {
      case ProcessStep.LoadModel:
        this.process_step = ProcessStep.LoadModel
        break
      case ProcessStep.LoadSkeleton:
        this.process_step = ProcessStep.LoadSkeleton
        break
      case ProcessStep.EditSkeleton:
        this.process_step = ProcessStep.EditSkeleton
        break
      case ProcessStep.BindPose:
        this.process_step = ProcessStep.BindPose
        break
      case ProcessStep.AnimationsListing:
        this.process_step = ProcessStep.AnimationsListing
        break
    }
  }

  // the retargeting functionality also uses, so expose this out publicly
  public show_animation_player (show: boolean): void {
    if (this.ui.dom_animation_player === null) {
      console.error('Cannot find animation player DOM element to show/hide')
      return
    }

    if (show) {
      this.ui.dom_animation_player.style.display = 'flex'
      return
    }

    this.ui.dom_animation_player.style.display = 'none'
  }

  public process_step_changed (process_step: ProcessStep): ProcessStep {
    // we will have the current step turn on the UI elements it needs
    this.ui.hide_all_elements()

    // update the current process step variable
    this.update_current_process_step(process_step)

    // clean up things related to steps in since we can navigate back and forth
    this.edit_skeleton_step.cleanup_on_exit_step()
    this.load_skeleton_step.dispose()

    // only show animation player on the animation listing page
    if (process_step === ProcessStep.AnimationsListing) {
      this.show_animation_player(true)
    } else {
      this.show_animation_player(false)
    }

    // bake model gizmo position into vertices before transitioning away from step 2
    if (this.is_model_gizmo_active) {
      this.bake_and_disable_model_gizmo()
    }

    // when we change steps, we are re-creating the skeleton and helper
    // so the current transform control reference will be lost/give an error
    this.transform_controls.detach()

    /**********
     * MAIN PROCESS FLOW LOGIC
     * I am doing else if here since the bindpose step changes the step at the end
     * we don't want to trigger the animation listing too early since it is the case after
     *********/
    if (this.process_step === ProcessStep.LoadModel) {
      // reset the state in the case of coming back to this step
      this.remove_imported_model()
      this.load_model_step.clear_loaded_model_data()
      this.load_model_step.begin()
    }
    else if (this.process_step === ProcessStep.LoadSkeleton) {
      // if skeleton helper existed because we are going back to this
      this.dispose_skeleton_helper()

      // need to change the texture display to normal material in
      this.mesh_preview_display_type = ModelPreviewDisplay.Textured
      this.changed_model_preview_display(this.mesh_preview_display_type)

      // initializing all the load skeleton step stuff
      this.scene.add(this.load_model_step.model_meshes())

      // enable model position gizmo so user can freely position the model
      this.enable_model_gizmo()

      // finish initialization and add origin markers
      // this needs to happen at the end since it is expecting the mesh data
      this.load_skeleton_step.begin()
    }
    else if (this.process_step === ProcessStep.EditSkeleton) {
      this.load_skeleton_step?.dispose()

      this.regenerate_skeleton_helper(this.edit_skeleton_step.skeleton())
      process_step = ProcessStep.EditSkeleton
      this.edit_skeleton_step.begin(this.scene, this.load_skeleton_step.skeleton_type())
      this.update_edit_bone_interaction_mode()
      this.transform_controls.setMode(this.transform_controls_type) // 'translate', 'rotate'

      this.sync_skeleton_helper_joint_visibility()

      this.changed_model_preview_display(this.mesh_preview_display_type) // show weight painted mesh by default
    }
    else if (this.process_step === ProcessStep.BindPose) {
      this.transform_controls.enabled = false // shouldn't be editing bones
      this.calculate_skin_weighting_for_models()

      this.remove_skinned_meshes_from_scene() // clean up in case we had skinned meshes in scene previously
      this.scene.add(...this.weight_skin_step.final_skinned_meshes()) // add final skinned mesh to scene

      this.weight_skin_step.weight_painted_mesh_group().visible = false // hide weight painted mesh
      this.process_step_changed(ProcessStep.AnimationsListing)
    }
    else if (this.process_step === ProcessStep.AnimationsListing) {
      this.process_step = ProcessStep.AnimationsListing

      const active_skeleton_type: SkeletonType = this.load_skeleton_step.skeleton_type()
      this.animations_listing_step.begin(active_skeleton_type, this.load_skeleton_step.skeleton_scale())

      // download options for export currently will only work for humanoid skeletons
      // since we will give options to change the bone names to other standard formats.
      this.download_settings.update_download_settings_ui_visibility(active_skeleton_type)

      // update reference of skeleton helper to use the final skinned mesh
      this.regenerate_skeleton_helper(this.weight_skin_step.skeleton())
      this.sync_skeleton_helper_joint_visibility()

      // hide skeleton by default in animations listing step
      if (this.ui.dom_show_skeleton_checkbox !== null) {
        this.ui.dom_show_skeleton_checkbox.checked = false
      }

      // Show/hide A-Pose correction options based on skeleton type
      this.update_a_pose_options_visibility()

      this.animations_listing_step.load_and_apply_default_animation_to_skinned_mesh(this.weight_skin_step.final_skinned_meshes())

      if (this.skeleton_helper !== undefined) {
        this.skeleton_helper.hide() // hide skeleton helper in animations listing step
      }
    }

    this.session_persistence?.handle_step_completed()

    return this.process_step
  } // end process_step_changed()


  private animate (): void {
    requestAnimationFrame(this.animate)
    const delta_time: number = this.clock.getDelta()

    this.scene_environment.frame_change()

    // camera shake effect
    this.camera_shake.update(delta_time)

    // if we are in the animation listing step, we can call
    // render/update functions in that
    if (this.process_step === ProcessStep.AnimationsListing) {
      this.animations_listing_step.frame_change(delta_time)
    }

    this.renderer.render(this.scene, this.camera)

    // view helper
    this.view_helper.render(this.renderer) // updates current viewport
    if (this.view_helper.animating) {
      this.view_helper.update(delta_time) // updates animation when clicking on axis
    }
  }

  public changed_model_preview_display (mesh_textured_display_type: ModelPreviewDisplay): void {
    this.mesh_preview_display_type = mesh_textured_display_type

    // show/hide loaded textured model depending on view
    this.load_model_step.model_meshes().visible = this.mesh_preview_display_type === ModelPreviewDisplay.Textured

    if (this.mesh_preview_display_type === ModelPreviewDisplay.WeightPainted) {
      this.regenerate_weight_painted_preview_mesh()
    }

    // show/hide weight painted mesh depending on view
    this.weight_skin_step.weight_painted_mesh_group().visible =
      this.mesh_preview_display_type === ModelPreviewDisplay.WeightPainted
  }

  public changed_transform_controls_mode (radio_button_selected: string): void {
    switch (radio_button_selected) {
      case 'translate':
        this.transform_controls_type = TransformControlType.Translation
        this.transform_controls.setMode('translate')
        break
      case 'rotation':
        this.transform_controls_type = TransformControlType.Rotation
        this.transform_controls.setMode('rotate')
        break
      default:
        console.warn(`Unknown transform mode selected: ${radio_button_selected}`)
        break
    }
  }

  public changed_transform_controls_space (radio_button_selected: TransformSpace | undefined): void {
    if (radio_button_selected) {
      this.transform_space_type = radio_button_selected
      this.transform_controls.setSpace(radio_button_selected as 'world' | 'local')
    } else {
      console.warn(`Unknown transform space selected`)
    }
  }

  public handle_transform_controls_mouse_down (mouse_event: MouseEvent | PointerEvent): void {
    // primary click is made for rotating around 3d scene
    const is_primary_button_click = mouse_event.button === 0

    if (is_primary_button_click === false) { return }

    if (this.edit_skeleton_step.skeleton()?.bones === undefined) { return }

    // when we are done with skinned mesh, we shouldn't be editing transforms
    if (!this.transform_controls.enabled) {
      return
    }

    // we will change which skeleton we do an intersection test with
    // depending on what step we are on. We are either moving the setup skeleton
    // or moving the bind pose skeleton
    const skeleton_to_test: Skeleton | undefined = this.edit_skeleton_step.skeleton()

    // if no skeleton to test, abort
    if (skeleton_to_test === undefined) {
      console.warn('No skeleton to test for intersection, aborting transform controls mouse down')
      return
    }

    // this returns 3 values, so we can destructure them. do not remove any of these
    // even if one of them is not used, otherwise there will be weird issues
    const [closest_bone, closest_bone_index, closest_distance] = Utility.raycast_closest_bone_test(this.camera, mouse_event, skeleton_to_test)

    // don't allow to select root bone for now
    if (closest_bone?.name === 'root') {
      return
    }

    if (!this.edit_skeleton_step.is_bone_selectable(closest_bone)) {
      return
    }

    // only do selection if we are close
    // the orbit controls also have panning with alt-click, so we don't want to interfere with that
    if (closest_distance === null || closest_distance > this.transform_controls_hover_distance) {
      return
    }

    if (closest_bone !== null) {
      this.transform_controls.attach(closest_bone)
      this.edit_skeleton_step.set_currently_selected_bone(closest_bone)
    } else {
      this.edit_skeleton_step.set_currently_selected_bone(null)
    }
  }

  public remove_skinned_meshes_from_scene (): void {
    const existing_skinned_meshes = this.scene.children.filter((child: THREE.Object3D) => child.name.includes('Skinned Mesh'))
    existing_skinned_meshes.forEach((existing_skinned_mesh: THREE.Object3D) => {
      Utility.remove_object_with_children(existing_skinned_mesh)
    })
  }

  public remove_imported_model (): void {
    if (this.load_model_step.model_meshes() !== undefined) {
      const imported_model = this.scene.getObjectByName('Imported Model')
      if (imported_model !== undefined) {
        this.scene.remove(imported_model)
      }
    }
  }

  public remove_weight_painted_mesh_preview (): void {
    if (this.load_model_step.model_meshes() !== undefined) {
      const weight_painted_mesh = this.scene.getObjectByName('Weight Painted Mesh Preview')
      if (weight_painted_mesh !== null) {
        this.scene.remove(weight_painted_mesh)
      }
    }
  }

  public regenerate_weight_painted_preview_mesh (): void {
    // needed for skinning process
    this.calculate_skin_weighting_for_models()

    // if the weight painted mesh is not in scene, add it
    if (this.scene.getObjectByName('Weight Painted Mesh') === undefined) {
      this.scene.add(this.weight_skin_step.weight_painted_mesh_group())
    }
  }

  private calculate_skin_weighting_for_models (): void {
    // we only need one binding skeleton. All skinned meshes will use this.
    this.weight_skin_step.reset_all_skin_process_data() // clear out any existing skinned meshes in storage

    // needed for skinning process if we change modes
    this.weight_skin_step.create_bone_formula_object(this.edit_skeleton_step.armature(), this.load_skeleton_step.skeleton_type())

    // Pass head weight correction settings to the weight skin step
    this.weight_skin_step.set_head_weight_correction_settings(
      this.edit_skeleton_step.use_head_weight_correction(),
      this.edit_skeleton_step.get_preview_plane_height()
    )

    // Pass arm plane correction settings to the weight skin step
    this.weight_skin_step.set_arm_plane_correction_settings(
      this.edit_skeleton_step.use_arm_plane_correction(),
      this.edit_skeleton_step.get_arm_plane_offset()
    )

    this.weight_skin_step.create_binding_skeleton()

    // add geometry data needed for skinning
    this.load_model_step.models_geometry_list().forEach((mesh_geometry) => {
      this.weight_skin_step.add_to_geometry_data_to_skin(mesh_geometry)
    })

    // all mesh material data associated with the geometry data
    this.load_model_step.models_material_list().forEach((mesh_material) => {
      this.weight_skin_step.add_mesh_material(mesh_material)
    })

    // perform skinning operation
    // this will take all the mesh geometry data we added above and create skinned meshes
    // TODO: Always regenerate the weight painted mesh preview for now. This will change later
    // when we have are in the "Weight Painted" display mode
    this.weight_skin_step.calculate_weights_for_all_mesh_data(true)

    // remember our skeleton position before we do the skinning process
    // that way if we revert to try again...we will have the original positions/rotations
    this.load_model_step.model_meshes().visible = false // hide our unskinned mesh after we have done the skinning process

    // re-define skeleton helper to use the skinned mesh)
    if (this.weight_skin_step.skeleton() === undefined) {
      console.warn('Tried to regenerate skeleton helper, but skeleton is undefined!')
    }
  }

  public setup_weight_skinning_config (): void {
    this.weight_skin_step.create_bone_formula_object(this.edit_skeleton_step.armature(), this.load_skeleton_step.skeleton_type())

    // Pass head weight correction settings to the weight skin step
    this.weight_skin_step.set_head_weight_correction_settings(
      this.edit_skeleton_step.use_head_weight_correction(),
      this.edit_skeleton_step.get_preview_plane_height()
    )

    // Pass arm plane correction settings to the weight skin step
    this.weight_skin_step.set_arm_plane_correction_settings(
      this.edit_skeleton_step.use_arm_plane_correction(),
      this.edit_skeleton_step.get_arm_plane_offset()
    )
  }

  public show_contributors_dialog (): void {
    new ModalDialog('Contributors', Generators.get_contributors_list()).show()
  }

  public show_learning_resources_dialog (): void {
    new ModalDialog('Learning Resources', Generators.get_learning_resources_html()).show()
  }


  /**
   * Populate shared HTML fragments that are reused across app pages.
   * This runs before UI/Theme initialization so expected DOM IDs exist
   * when singleton classes bind their element references and listeners.
   */
  private initialize_shared_dom_mounts (): void {
    const top_nav_links_mount = document.querySelector('#top-nav-links-mount')
    if (top_nav_links_mount instanceof HTMLElement) {
      DOMUtilities.populate_top_nav_links(top_nav_links_mount)
    }

    const header_ui_mount = document.querySelector('#header-ui-mount')
    if (header_ui_mount instanceof HTMLElement) {
      DOMUtilities.populate_header_controls(header_ui_mount)
    }

    const animation_player_mount = document.querySelector('#animation-player-mount')
    if (animation_player_mount instanceof HTMLElement) {
      DOMUtilities.populate_animation_player(animation_player_mount)
    }

    const arm_extension_mount = document.querySelector('#arm-extension-mount')
    if (arm_extension_mount instanceof HTMLElement) {
      DOMUtilities.populate_arm_extension_controls(arm_extension_mount)
    }

    const download_control_mount = document.querySelector('#download-control-mount')
    if (download_control_mount instanceof HTMLElement) {
      DOMUtilities.populate_download_control(download_control_mount)
    }

    const settings_dropdown_mount = document.querySelector('#settings-dropdown-mount')
    if (settings_dropdown_mount instanceof HTMLElement) {
      DOMUtilities.populate_settings_dropdown(settings_dropdown_mount)
    }
  }

} // end Mesh2Motion Engine
