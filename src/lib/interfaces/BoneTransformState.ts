import { type Quaternion, type Vector3 } from 'three'

export default class BoneTransformState {
  public name: string
  public position: Vector3
  public rotation: Quaternion
  public scale: Vector3

  constructor (name = '', position: Vector3, rotation: Quaternion, scale: Vector3) {
    this.name = name
    this.position = position
    this.rotation = rotation
    this.scale = scale
  }
}
